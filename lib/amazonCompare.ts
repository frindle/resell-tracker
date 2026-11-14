// Compare a parsed Amazon order with what the tracker has stored. Pure: no
// database, no network. The rules are "compare, don't clobber":
//  - not stored            -> create (if the page has enough to create from)
//  - stored, locked        -> leave alone
//  - stored, blank field   -> propose filling only that field
//  - stored, different     -> never overwrite; report a discrepancy
// Fields the user hand-edited (userEditedFields) are never touched.
import type { ParsedOrder } from './amazonPageParse.ts';
import { taxFields } from './amazonTax.ts';
import { parseUserEditedFields } from './orderFieldSync.ts';

export interface ExistingOrder {
  id: number;
  orderNumber: string | null;
  orderDate: Date;
  cost: number;
  itemDescription: string | null;
  shippingAddress: string | null;
  trackingNumbers: string | null;
  taxAmount: number | null;
  cardId: number | null;
  cardLast4s: string[];        // last4 values of the stored card (primary + additional)
  noRushBonusPercent: number | null;
  locked: boolean;
  cancelled: boolean;
  userEditedFields: string | null;
  hasPhoto: boolean;
}

export interface FieldChange { field: string; from: unknown; to: unknown }
export interface Discrepancy { field: string; stored: unknown; page: unknown }

export type OrderActionKind = 'create' | 'fill' | 'unchanged' | 'locked' | 'incomplete';

export interface OrderAction {
  orderNumber: string;
  action: OrderActionKind;
  changes: FieldChange[];        // proposed (compare-only) or applied fills; for create, the initial values
  discrepancies: Discrepancy[];
  /** true when this order still lacks tracking, card or tax and a detail/tracking page could supply it */
  needsDetail: boolean;
}

export interface CompareContext {
  savedCardLast4s: Set<string>;  // last4s of the user's saved cards, to know whether a card fill can resolve
}

const isUseless = (d: string | null | undefined) => {
  const t = (d ?? '').trim().toLowerCase();
  return !t || t === 'walmart.com' || t === 'amazon.com' || t === 'costco.com';
};
const norm = (s: string | null | undefined) => (s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const dayDiff = (a: string, b: string) => Math.abs(Date.parse(a + 'T00:00:00Z') - Date.parse(b + 'T00:00:00Z')) / 86400000;

export function addressesDiffer(a: string, b: string): boolean {
  const x = norm(a), y = norm(b);
  if (!x || !y) return false;
  return !(x === y || x.includes(y) || y.includes(x));
}

export function compareOrder(page: ParsedOrder, existing: ExistingOrder | null, ctx: CompareContext): OrderAction {
  const orderNumber = page.orderNumber;
  const tax = page.cost ? taxFields(page.cost, page.taxAmount ?? null) : {};

  if (!existing) {
    const canCreate = !!page.orderDate && typeof page.cost === 'number' && page.cost > 0;
    const changes: FieldChange[] = [];
    if (canCreate) {
      const add = (field: string, to: unknown) => { if (to !== undefined && to !== null && to !== '' && !(Array.isArray(to) && !to.length)) changes.push({ field, from: null, to }); };
      add('orderDate', page.orderDate); add('cost', page.cost); add('itemDescription', page.itemDescription);
      add('shippingAddress', page.shippingAddress); add('trackingNumbers', page.trackingNumbers.join(','));
      add('cardLast4', page.paymentLast4); add('paymentRatePercent', page.paymentRatePercent);
      add('taxAmount', tax.taxAmount); add('noRushBonusPercent', page.noRushBonusPercent); add('deliveryPhotoUrl', page.deliveryPhotoUrl);
    }
    return { orderNumber, action: canCreate ? 'create' : 'incomplete', changes, discrepancies: [], needsDetail: true };
  }

  const edited = new Set(parseUserEditedFields(existing.userEditedFields));
  const needsDetail = !existing.trackingNumbers || existing.cardId == null || existing.taxAmount == null;

  if (existing.locked) {
    return { orderNumber, action: 'locked', changes: [], discrepancies: [], needsDetail: false };
  }

  const changes: FieldChange[] = [];
  const discrepancies: Discrepancy[] = [];

  if (isUseless(existing.itemDescription) && page.itemDescription && !edited.has('itemDescription')) {
    changes.push({ field: 'itemDescription', from: existing.itemDescription, to: page.itemDescription });
  }

  if (page.shippingAddress) {
    if (!existing.shippingAddress) {
      if (!edited.has('shippingAddress')) changes.push({ field: 'shippingAddress', from: null, to: page.shippingAddress });
    } else if (addressesDiffer(existing.shippingAddress, page.shippingAddress)) {
      discrepancies.push({ field: 'shippingAddress', stored: existing.shippingAddress, page: page.shippingAddress });
    }
  }

  if (page.trackingNumbers.length) {
    if (!existing.trackingNumbers) {
      if (!edited.has('trackingNumbers')) changes.push({ field: 'trackingNumbers', from: null, to: page.trackingNumbers.join(',') });
    } else {
      const stored = existing.trackingNumbers.split(',').map(t => t.trim().toUpperCase()).filter(Boolean);
      const overlap = page.trackingNumbers.some(t => stored.includes(t.toUpperCase()));
      if (!overlap) discrepancies.push({ field: 'trackingNumbers', stored: existing.trackingNumbers, page: page.trackingNumbers.join(',') });
    }
  }

  if (page.paymentLast4) {
    if (existing.cardId == null) {
      if (!edited.has('cardId') && ctx.savedCardLast4s.has(page.paymentLast4)) {
        changes.push({ field: 'cardId', from: null, to: `card ending ${page.paymentLast4}${page.paymentRatePercent != null ? ` (${page.paymentRatePercent}%)` : ''}` });
      }
    } else if (existing.cardLast4s.length && !existing.cardLast4s.includes(page.paymentLast4)) {
      discrepancies.push({ field: 'card', stored: `ending ${existing.cardLast4s.join('/')}`, page: `ending ${page.paymentLast4}` });
    }
  }

  if (tax.taxAmount !== undefined) {
    if (existing.taxAmount == null) {
      if (!edited.has('taxAmount')) changes.push({ field: 'taxAmount', from: null, to: tax.taxAmount });
    } else if (Math.abs(existing.taxAmount - tax.taxAmount) > 0.01) {
      discrepancies.push({ field: 'taxAmount', stored: existing.taxAmount, page: tax.taxAmount });
    }
  }

  if (page.noRushBonusPercent != null && existing.noRushBonusPercent == null && !edited.has('noRushBonusPercent')) {
    changes.push({ field: 'noRushBonusPercent', from: null, to: page.noRushBonusPercent });
  }

  if (page.deliveryPhotoUrl && !existing.hasPhoto) {
    changes.push({ field: 'deliveryPhotoUrl', from: null, to: page.deliveryPhotoUrl });
  }

  if (page.orderDate && dayDiff(isoDay(existing.orderDate), page.orderDate) > 1) {
    discrepancies.push({ field: 'orderDate', stored: isoDay(existing.orderDate), page: page.orderDate });
  }
  if (page.cost && existing.cost > 0 && Math.abs(existing.cost - page.cost) > 0.01) {
    discrepancies.push({ field: 'cost', stored: existing.cost, page: page.cost });
  }

  return {
    orderNumber,
    action: changes.length ? 'fill' : 'unchanged',
    changes, discrepancies, needsDetail,
  };
}
