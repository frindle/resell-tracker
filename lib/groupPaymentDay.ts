// Pure helpers for stored group payments (no database import, so plain tests can load them).

/** The calendar day in a group's timestamp text: "2026-07-09 10:00:00", "2026-07-09T10:00:00Z" or "07/09/2026 10:00:00". null otherwise. */
export function dayOf(text: string | null | undefined): string | null {
  const s = (text ?? '').trim();
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return us ? `${us[3]}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}` : null;
}

/**
 * The day a payment was made: its sendOn (the bank deposit posts on it), else its receivedOn, else the date inside a name like
 * "P1056-20260709". null when none is usable.
 */
export function paymentDay(receivedOn: string | null | undefined, name: string, sendOn?: string | null): string | null {
  const d = dayOf(sendOn) ?? dayOf(receivedOn);
  if (d) return d;
  const m = name.match(/^P\d+-(\d{4})(\d{2})(\d{2})$/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/**
 * What a card is worth after all of CardCenter's adjustments: the listing's own purchasePrice when the API gives one (a fee or
 * clawback line on an earlier payment's card lowers it), else the line amount, but never a negative line amount (undefined then).
 */
export function cardNetPrice(lineAmount: number, purchasePrice: number | null | undefined): number | undefined {
  if (typeof purchasePrice === 'number' && Number.isFinite(purchasePrice)) return purchasePrice;
  return lineAmount >= 0 ? lineAmount : undefined;
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

/** One BFMR paid day ready to store as a group payment. `exact`: every cent of the total is assigned to a known order. */
export type BfmrDayPayment = { ref: string; day: string; amountCents: number; orders: { orderId: number; cents: number }[]; exact: boolean };

/**
 * The stored form of BFMR's single-day batches (the cross-midnight combinations are left out: they are guesses). A day with a
 * reservation that has no (or too few) order links is not exact and is stored as a total only, so nothing is guessed for it.
 */
export function bfmrDayPayments(batches: BfmrBatch[]): BfmrDayPayment[] {
  return batches.filter(b => b.ref === `bfmr:${b.day}`).map(b => ({
    ref: `bfmr-${b.day}`, day: b.day, amountCents: b.amountCents, orders: b.orders,
    exact: b.orders.length > 0 && b.orders.reduce((a, o) => a + o.cents, 0) === b.amountCents,
  }));
}

// ---- one BFMR deposit must not be offered twice ----

/** The shape dedupBfmrPayments needs from a payment (a MatchGroupPayment fits). */
export type BfmrDedupPayment = { id: number; group?: string; ref?: string; paidDay: string; amountCents: number; orders: { orderId: number; cents: number }[] };

/** A BFMR payment made from the reservations (a stored `bfmr-YYYY-MM-DD` day or a batch derived at match time), not from BFMR's own payment email. */
export const isReservationDerived = (p: BfmrDedupPayment): boolean =>
  p.group === 'bfmr' && (p.id < 0 || /^bfmr:bfmr-\d{4}-\d{2}-\d{2}$/.test(p.ref ?? ''));

const gapDays = (a: string, b: string) => Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000;

/**
 * BFMR's own payment email (an exact stored row under any other ref) is the better record of a deposit than the one rebuilt from
 * reservations, so a reservation-derived payment sharing any order with it is dropped. An email payment stored as a total only
 * (no orders) is dropped when another BFMR payment with the same amount, within a day, names orders. Other groups are untouched.
 */
export function dedupBfmrPayments<T extends BfmrDedupPayment>(all: readonly T[]): T[] {
  const bfmr = all.filter(p => p.group === 'bfmr');
  const emailExact = bfmr.filter(p => !isReservationDerived(p) && p.orders.length > 0);
  const covered = new Set(emailExact.flatMap(p => p.orders.map(o => o.orderId)));
  const drop = new Set<T>();
  for (const p of bfmr) {
    if (isReservationDerived(p) && p.orders.some(o => covered.has(o.orderId))) drop.add(p);
  }
  for (const p of bfmr) {
    if (isReservationDerived(p) || p.orders.length > 0) continue;
    if (bfmr.some(q => q !== p && !drop.has(q) && q.orders.length > 0 && q.amountCents === p.amountCents && gapDays(q.paidDay, p.paidDay) <= 1)) drop.add(p);
  }
  return all.filter(p => !drop.has(p));
}
