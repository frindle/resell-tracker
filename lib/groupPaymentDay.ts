// Pure helpers for stored group payments (no database import, so plain tests can load them).

/** The calendar day in a group's timestamp text: "2026-07-09 10:00:00", "2026-07-09T10:00:00Z" or "07/09/2026 10:00:00". null otherwise. */
export function dayOf(text: string | null | undefined): string | null {
  const s = (text ?? '').trim();
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return us ? `${us[3]}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}` : null;
}

/** The day a payment was made: its receivedOn, else the date inside a name like "P1056-20260709". null when neither is usable. */
export function paymentDay(receivedOn: string | null | undefined, name: string): string | null {
  const d = dayOf(receivedOn);
  if (d) return d;
  const m = name.match(/^P\d+-(\d{4})(\d{2})(\d{2})$/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/** The buyer most of the orders belong to (ties: the lowest id); null when none has a buyer. */
export function commonBuyerId(buyerIds: (number | null)[]): number | null {
  const n = new Map<number, number>();
  for (const b of buyerIds) if (b != null) n.set(b, (n.get(b) ?? 0) + 1);
  return [...n].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] ?? null;
}

// ---- BFMR: payment batches derived at match time ----

/** One BFMR reservation (a /my-tracker item) that has a paid date, with the orders it is linked to. */
export type BfmrPaidRes = {
  id: number; qty: number; day: string;
  /** amount_paid from the item's raw JSON, dollars; null when absent. */
  amountPaid: number | null;
  /** total_payout, dollars: used only when amount_paid is absent. */
  totalPayout: number | null;
  links: { orderId: number; quantity: number }[];
};
export type BfmrBatch = { ref: string; day: string; amountCents: number; orders: { orderId: number; cents: number }[]; usedPayoutFallback: boolean };

const addDays = (day: string, n: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

/**
 * BFMR pays the reservations paid on one day as one batch: the batch total is the sum of their amount_paid (total_payout only
 * for a reservation without amount_paid). Each reservation's cents go to its linked orders by quantity; a reservation whose links
 * do not cover its quantity adds to the total but to no order, so that batch is not exact. `paidByOrder` is what BFMR actually
 * paid per order (only orders whose reservations are all paid, with amount_paid, and fully linked). date_paid is a timestamp,
 * so a batch that crosses midnight is also offered as the two days together (day = the later one).
 */
export function bfmrBatches(rs: BfmrPaidRes[]): { batches: BfmrBatch[]; paidByOrder: Map<number, number> } {
  type Day = { cents: number; fallback: boolean; orders: Map<number, number> };
  const days = new Map<string, Day>();
  const paidByOrder = new Map<number, number>();
  const unclean = new Set<number>();
  for (const r of rs) {
    const hasPaid = r.amountPaid != null && r.amountPaid > 0;
    const dollars = hasPaid ? r.amountPaid! : r.totalPayout != null && r.totalPayout > 0 ? r.totalPayout : null;
    if (dollars == null) continue;
    const cents = Math.round(dollars * 100);
    const d = days.get(r.day) ?? days.set(r.day, { cents: 0, fallback: false, orders: new Map() }).get(r.day)!;
    d.cents += cents;
    if (!hasPaid) d.fallback = true;
    const links = [...r.links].sort((a, b) => a.orderId - b.orderId);
    const covered = r.qty > 0 && links.reduce((a, l) => a + l.quantity, 0) === r.qty;
    if (!covered) { for (const l of links) unclean.add(l.orderId); continue; }
    let given = 0;
    links.forEach((l, i) => {
      const share = i === links.length - 1 ? cents - given : Math.floor(cents * l.quantity / r.qty);
      given += share;
      d.orders.set(l.orderId, (d.orders.get(l.orderId) ?? 0) + share);
      if (hasPaid) paidByOrder.set(l.orderId, (paidByOrder.get(l.orderId) ?? 0) + share); else unclean.add(l.orderId);
    });
  }
  for (const id of unclean) paidByOrder.delete(id);
  const toBatch = (ref: string, day: string, parts: Day[]): BfmrBatch => {
    const orders = new Map<number, number>();
    for (const p of parts) for (const [o, c] of p.orders) orders.set(o, (orders.get(o) ?? 0) + c);
    return {
      ref, day, amountCents: parts.reduce((a, p) => a + p.cents, 0), usedPayoutFallback: parts.some(p => p.fallback),
      orders: [...orders].sort((a, b) => a[0] - b[0]).map(([orderId, cents]) => ({ orderId, cents })),
    };
  };
  const batches: BfmrBatch[] = [];
  for (const [day, d] of [...days].sort((a, b) => a[0].localeCompare(b[0]))) {
    batches.push(toBatch(`bfmr:${day}`, day, [d]));
    const prev = days.get(addDays(day, -1));
    if (prev) batches.push(toBatch(`bfmr:${addDays(day, -1)}+${day}`, day, [prev, d]));
  }
  return { batches, paidByOrder };
}
