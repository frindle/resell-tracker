import { looksLikeAddress } from './orderFieldSync.ts';

// What the sidecar is asked to fetch for orders the email import left
// incomplete. Pure, so it can be tested without a database.
//
// Retail emails leave things out: Walmart's order email has no item names
// ("2 items"), some have no address line the parser can read, and shipping
// emails can lack the carrier number. The retailer's order page has all of
// it, and the sidecar already scrapes those pages for the account it is
// signed in to. So right after an import, orders on that account that are
// still missing something queue the store's sync instead of waiting for the
// next scheduled one. The import route only fills empty fields, so a sync
// never replaces anything the email or a person set.
//
// Which gaps a store's page can fill:
//   Walmart: item, address, tracking and card, per order (SYNC_WALMART_ORDER
//            opens the order page; its email has no item names).
//   Costco:  item, address, tracking and card, per order (SYNC_COSTCO_ORDER
//            reads Costco's order-details data; its order email has no
//            address and no card). eGift orders have no shipping address.
//   Amazon:  item (its emails carry "Name - City, ST", which is enough for
//            shipping rules; tracking is already queued by the import).
// Other stores (Lenovo, new ones) have no sidecar scraper.

export type Gap = 'item' | 'address' | 'tracking' | 'card' | 'group';

export type GapOrder = {
  platform: string;
  orderNumber: string;
  itemDescription: string | null;
  shippingAddress: string | null;
  trackingNumbers: string | null;
  /** A shipping or delivery email was imported for it in this run. */
  shipped: boolean;
  /** The card it was paid with; left out when the caller does not know. */
  cardId?: number | null;
  /** A cancelled order is filled like a live one (item, card, address) but never gets tracking. */
  cancelled?: boolean;
  /** The group (buyer). Only an explicit null counts as a gap; left out = the caller does not know. */
  buyerId?: number | null;
  /** Locked and cancelled orders are the person's to leave alone: only the group is ever filled on them. */
  groupOnly?: boolean;
};

export type GapFillPlan = {
  /** Walmart orders for the per-order page read (SYNC_WALMART_ORDER). */
  walmartOrders: string[];
  /** Costco orders for the per-order details lookup (SYNC_COSTCO_ORDER). */
  costcoOrders: string[];
  /** Amazon orders for the targeted per-order lookup (read by the browser extension). */
  amazonOrders: string[];
};

// 'group' is read off the page's ship-to address (the shipping rules turn the
// address into a group), so every store whose page gives an address can fill it.
const FILLABLE: Record<string, readonly Gap[]> = {
  Walmart: ['item', 'address', 'tracking', 'card', 'group'],
  Costco: ['item', 'address', 'tracking', 'card', 'group'],
  Amazon: ['item', 'group'],
};

/** Same rule as the import route: a store name alone is not an item description. */
export function isUselessDescription(desc: string | null | undefined): boolean {
  if (!desc) return true;
  const d = desc.trim().toLowerCase();
  return !d || d === 'walmart.com' || d === 'amazon.com' || d === 'costco.com';
}

// A name built from an email's categories ("Wearable Technology (1 items)",
// "Laptops, Electronics (3 items)", see emailParse.ts). Worth keeping until a
// real title turns up, but a real title replaces it.
const CATEGORY_PLACEHOLDER_RE = /^[a-z][a-z &,']{1,120} \(\d{1,3} items?\)$/i;

export function isPlaceholderDescription(desc: string | null | undefined): boolean {
  return !!desc && CATEGORY_PLACEHOLDER_RE.test(desc.trim());
}

/** Blank, a store name, or a category placeholder: a real item title may replace it. */
export function isReplaceableDescription(desc: string | null | undefined): boolean {
  return isUselessDescription(desc) || isPlaceholderDescription(desc);
}

export function orderGaps(o: GapOrder): Gap[] {
  if (o.groupOnly) return o.buyerId === null ? ['group'] : [];
  const gaps: Gap[] = [];
  if (isUselessDescription(o.itemDescription)) gaps.push('item');
  if (!looksLikeAddress(o.shippingAddress ?? '')) gaps.push('address');
  if (o.shipped && !o.cancelled && !String(o.trackingNumbers ?? '').trim()) gaps.push('tracking');
  if (o.cardId === null) gaps.push('card');
  if (o.buyerId === null) gaps.push('group');
  return gaps;
}

/** Gaps the store's page can fill; empty when there is nothing to fetch. */
export function fillableGaps(o: GapOrder): Gap[] {
  const can = FILLABLE[o.platform] ?? [];
  return orderGaps(o).filter(g => can.includes(g));
}

export function planGapFill(orders: readonly GapOrder[]): GapFillPlan {
  const walmart: string[] = [];
  const costco: string[] = [];
  const amazon: string[] = [];
  for (const o of orders) {
    if (!fillableGaps(o).length) continue;
    // Amazon's queued lookup is a tracking lookup: nothing to fetch for a cancelled order.
    if (o.cancelled && o.platform === 'Amazon') continue;
    const byOrder = o.platform === 'Amazon' ? amazon : o.platform === 'Costco' ? costco : o.platform === 'Walmart' ? walmart : null;
    if (byOrder && o.orderNumber && !byOrder.includes(o.orderNumber)) byOrder.push(o.orderNumber);
  }
  return { walmartOrders: walmart, costcoOrders: costco, amazonOrders: amazon };
}

/** One log line per run, with counts only. */
export function gapFillLine(orders: readonly GapOrder[], plan: GapFillPlan): string {
  const counts = new Map<string, number>();
  for (const o of orders) for (const g of fillableGaps(o)) counts.set(`${o.platform}.${g}`, (counts.get(`${o.platform}.${g}`) ?? 0) + 1);
  const gaps = [...counts].map(([k, n]) => `${k}=${n}`).join(' ');
  const queued = [
    ...(plan.walmartOrders.length ? [`SYNC_WALMART_ORDER:${plan.walmartOrders.length}`] : []),
    ...(plan.costcoOrders.length ? [`SYNC_COSTCO_ORDER:${plan.costcoOrders.length}`] : []),
    ...(plan.amazonOrders.length ? [`TRACK_AMAZON:${plan.amazonOrders.length}`] : []),
  ];
  return `[gap-fill] ${gaps || 'none'} queued=${queued.join(',') || 'none'}`;
}
