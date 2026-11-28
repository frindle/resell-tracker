// Darkbloom purchases: an order that is really a cost of the Darkbloom business (hardware, supplies...). Its cost is kept
// in bloom-ledger, not in resell's Cost table. Pure: the payload builder, the amount, the item lines, the push decision and
// the bank-row suggestion. lib/darkbloomPurchaseService.ts does the database and HTTP work.
import { isReplaceableDescription } from './gapFill.ts';

export const BLOOM_CATEGORIES = ['hardware', 'software', 'internet', 'electricity', 'supplies', 'other'] as const;
export type BloomCategory = (typeof BLOOM_CATEGORIES)[number];
export const DEFAULT_CATEGORY: BloomCategory = 'supplies';
export const isBloomCategory = (v: unknown): v is BloomCategory => typeof v === 'string' && (BLOOM_CATEGORIES as readonly string[]).includes(v);

const cents = (d: number) => Math.round((Number.isFinite(d) ? d : 0) * 100);

export type PurchaseOrder = {
  id: number; platform: string; orderNumber: string | null;
  orderDate: string; // YYYY-MM-DD, Los Angeles
  cost: number; shippingCost: number; taxAmount: number | null; subtotalAmount: number | null;
  itemDescription: string | null;
  cardLast4: string | null;
  darkbloomCategory: string | null; darkbloomMachineId: string | null;
  bloomEntryId: number | null; bloomPushedSig: string | null; bloomRev: number;
  cancelled: boolean;
};

/**
 * What the card was charged. Subtotal and tax both known: their sum (the same figure the bank matcher expects, and
 * Amazon's subtotal already holds shipping). Otherwise cost plus shipping (`cost` is what the importer saw as the total).
 */
export function chargeCents(o: Pick<PurchaseOrder, 'cost' | 'shippingCost' | 'taxAmount' | 'subtotalAmount'>): number {
  if (o.subtotalAmount != null && o.taxAmount != null) return cents(o.subtotalAmount) + cents(o.taxAmount);
  return cents(o.cost) + cents(o.shippingCost);
}

export type ItemLine = { qty: number; name: string };
export type PackageItems = { title: string; quantity: number }[];

/**
 * The items of an order as "qty x name" lines, or null while they are not known: the email-only placeholder
 * ("Electronics (1 items)") is not an item. Items a shipment page read win; else a real title from the page counts once.
 */
export function itemLines(itemDescription: string | null, packages: readonly PackageItems[]): ItemLine[] | null {
  const byName = new Map<string, ItemLine>();
  for (const p of packages) for (const it of p) {
    const name = String(it.title ?? '').trim();
    if (!name) continue;
    const qty = Number.isInteger(it.quantity) && it.quantity > 0 ? it.quantity : 1;
    const prev = byName.get(name);
    if (prev) prev.qty += qty; else byName.set(name, { qty, name });
  }
  if (byName.size) return [...byName.values()];
  if (!isReplaceableDescription(itemDescription)) return [{ qty: 1, name: String(itemDescription).trim() }];
  return null;
}

export const lineText = (l: ItemLine) => `${l.qty} × ${l.name}`;

export type CostEntry = {
  kind: 'cost'; date: string; amount_cents: number; category: BloomCategory; vendor: string; note: string; purpose: string;
  business_pct: 100; ref: string; machine_id?: string;
};

export const entryRef = (orderId: number, rev: number) => `resell:order:${orderId}${rev > 0 ? `:r${rev}` : ''}`;

/** The body of POST /v1/accounting/entries. The caller has checked the order is ready (amount and items known). */
export function buildEntry(o: PurchaseOrder, lines: readonly ItemLine[]): CostEntry {
  const note = [o.orderNumber ? `Order ${o.orderNumber}` : `Order #${o.id}`, ...lines.map(lineText)].join('\n').slice(0, 1000);
  const category = isBloomCategory(o.darkbloomCategory) ? o.darkbloomCategory : DEFAULT_CATEGORY;
  return {
    kind: 'cost', date: o.orderDate, amount_cents: chargeCents(o), category, vendor: o.platform.slice(0, 120), note,
    purpose: o.cardLast4 && /^\d{4}$/.test(o.cardLast4) ? `Paid with card ending ${o.cardLast4}` : 'Darkbloom purchase',
    business_pct: 100, ref: entryRef(o.id, o.bloomRev),
    ...(category === 'hardware' && o.darkbloomMachineId ? { machine_id: o.darkbloomMachineId } : {}),
  };
}

/** A short stable string of what the entry says (not its ref), to tell whether a pushed entry is out of date. */
export const entrySig = (e: CostEntry): string => JSON.stringify([e.date, e.amount_cents, e.category, e.vendor, e.note, e.purpose, e.machine_id ?? null]);

export type PushPlan =
  | { do: 'none' }                        // not a Darkbloom purchase and nothing pushed
  | { do: 'void' }                        // unmarked (or cancelled) with an entry still in the ledger
  | { do: 'wait'; why: 'items' | 'amount' }
  | { do: 'pending'; why: 'no-ledger' | 'no-key' }
  | { do: 'post' }
  | { do: 'repost' }                      // void the old entry, then post the new one
  | { do: 'synced' };

export type PlanInput = {
  marked: boolean; cancelled: boolean; entryId: number | null; pushedSig: string | null;
  lines: ItemLine[] | null; amountCents: number; sig: string | null; url: boolean; token: boolean;
};

/** What to do next for one order. Never posts twice: an order with an entry id is only ever re-posted after a void. */
export function planPush(i: PlanInput): PushPlan {
  if (!i.marked || i.cancelled) return i.entryId != null ? (i.token && i.url ? { do: 'void' } : { do: 'pending', why: i.url ? 'no-key' : 'no-ledger' }) : { do: 'none' };
  if (!i.lines) return { do: 'wait', why: 'items' };
  if (!(i.amountCents > 0)) return { do: 'wait', why: 'amount' };
  if (!i.url) return { do: 'pending', why: 'no-ledger' };
  if (!i.token) return { do: 'pending', why: 'no-key' };
  if (i.entryId == null) return { do: 'post' };
  return i.pushedSig === i.sig ? { do: 'synced' } : { do: 'repost' };
}

export type PurchaseStatus = { state: 'none' | 'synced' | 'waiting-items' | 'pending-push' | 'void-pending' | 'error'; text: string };

/** The line the pages show for an order. `note` is Order.bloomPushNote. */
export function purchaseStatus(o: { darkbloomCategory: string | null; bloomEntryId: number | null; bloomPushNote: string | null; bloomPushedSig?: string | null }): PurchaseStatus {
  if (o.darkbloomCategory == null) return o.bloomEntryId != null ? { state: 'void-pending', text: 'Unmarked; the ledger entry still has to be voided' } : { state: 'none', text: '' };
  if (o.bloomEntryId != null && !o.bloomPushNote) return { state: 'synced', text: `In bloom-ledger as entry ${o.bloomEntryId}` };
  const n = o.bloomPushNote ?? '';
  if (n === 'items') return { state: 'waiting-items', text: 'Waiting for item details from the merchant page' };
  if (n === 'no-key' || n === 'no-ledger') return { state: 'pending-push', text: 'Pending push: set the bloom-ledger address and key' };
  if (n === 'auth') return { state: 'pending-push', text: 'Pending push: the ledger refused the key (missing or revoked)' };
  return { state: n ? 'error' : 'pending-push', text: n ? `Push failed: ${n}` : 'Pending push' };
}

// ---- bank rows ----

/** The suggestion for a card charge that is a Darkbloom purchase. `exact`: amount fits exactly (subtotal and tax known). */
export type DarkbloomCostSuggestion = { kind: 'darkbloom_cost'; orderIds: number[]; exact: boolean };

/** Auto-link only a single, exact match. */
export function darkbloomAutoPick(s: DarkbloomCostSuggestion): number | null {
  return s.orderIds.length === 1 && s.exact ? s.orderIds[0] : null;
}

/** Auto-link a blocked-order charge only for a single, exact match whose order no other open row also fits. */
export function personalOrderAutoPick(s: { orderIds: number[]; exact: boolean }, claims: ReadonlyMap<number, number>): number | null {
  return s.orderIds.length === 1 && s.exact && (claims.get(s.orderIds[0]) ?? 0) === 1 ? s.orderIds[0] : null;
}
