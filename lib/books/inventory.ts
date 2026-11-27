// Inventory on hand, one lot per order (specific ID). A lot's value is its lines on the inventory accounts through the
// as-of date. Lots add up to the inventory account balances by construction; the report carries both so a stray line
// without an order shows up as its own "no order" lot instead of vanishing.
import type { LedgerLineRow } from './types.ts';

export type InventoryLot = {
  orderId: number | null; // null: lines with no order (a manual line)
  goodsCents: number;
  giftCardsCents: number;
  valueCents: number;
  acquired: string; // the order's date when known, else the lot's first debit date
  ageDays: number;
  bucket: string;
};

export const AGE_BUCKETS = ['0-30', '31-60', '61-90', '91-180', '181+'] as const;
export const bucketOf = (days: number) => (days <= 30 ? '0-30' : days <= 60 ? '31-60' : days <= 90 ? '61-90' : days <= 180 ? '91-180' : '181+');

const dayNum = (d: string) => Math.floor(Date.parse(`${d}T12:00:00Z`) / 86_400_000);

export type InventoryReport = {
  asOf: string;
  lots: InventoryLot[];
  buckets: { bucket: string; lots: number; valueCents: number }[];
  totalCents: number;
  accountBalanceCents: number; // accounts 1400 + 1410 straight from the ledger
  differenceCents: number;
};

export function inventoryOnHand(lines: LedgerLineRow[], asOf: string, orderDates?: Map<number, string>): InventoryReport {
  const lots = new Map<number | null, InventoryLot>();
  let accountBalance = 0;
  for (const l of lines) {
    if (l.date > asOf) continue;
    const goods = l.systemKey === 'inventory_goods';
    const gift = l.systemKey === 'inventory_giftcards';
    if (!goods && !gift) continue;
    accountBalance += l.amountCents;
    let lot = lots.get(l.orderId);
    if (!lot) { lot = { orderId: l.orderId, goodsCents: 0, giftCardsCents: 0, valueCents: 0, acquired: '', ageDays: 0, bucket: '' }; lots.set(l.orderId, lot); }
    if (goods) lot.goodsCents += l.amountCents; else lot.giftCardsCents += l.amountCents;
    lot.valueCents += l.amountCents;
    if (l.amountCents > 0 && (!lot.acquired || l.date < lot.acquired)) lot.acquired = l.date;
  }
  const out: InventoryLot[] = [];
  for (const lot of lots.values()) {
    if (lot.valueCents === 0) continue;
    const od = lot.orderId != null ? orderDates?.get(lot.orderId) : undefined;
    if (od && od <= asOf) lot.acquired = od;
    if (!lot.acquired) lot.acquired = asOf;
    lot.ageDays = Math.max(0, dayNum(asOf) - dayNum(lot.acquired));
    lot.bucket = bucketOf(lot.ageDays);
    out.push(lot);
  }
  out.sort((a, b) => b.ageDays - a.ageDays || (a.orderId ?? 0) - (b.orderId ?? 0));
  const buckets = AGE_BUCKETS.map(b => {
    const ls = out.filter(x => x.bucket === b);
    return { bucket: b as string, lots: ls.length, valueCents: ls.reduce((s, x) => s + x.valueCents, 0) };
  });
  const total = out.reduce((s, x) => s + x.valueCents, 0);
  return { asOf, lots: out, buckets, totalCents: total, accountBalanceCents: accountBalance, differenceCents: total - accountBalance };
}
