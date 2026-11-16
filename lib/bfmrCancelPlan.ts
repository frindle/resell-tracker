// Which BFMR reservations to cancel on BFMR when a retailer's cancellation
// email cancels the whole order. Pure, so it can be tested without a database.
//
// Cancelling a reservation on BFMR gives the slot up, so it happens only when
// everything lines up (Penn, 2026-11-16: "assuming everything matches,
// purchase price, order number, etc."):
//   - the reservation is still reserved or purchased (not shipped or paid);
//   - all of it belongs to this order: BFMR cancels by reserve id, which
//     covers every split line under it, so no line may be linked to another
//     order and the order's links must cover the whole quantity;
//   - any order number BFMR has on file is this order's;
//   - the reservations' retail total is close to what the order cost
//     (85% to 115%: tax on top, or a coupon below).
// Anything else stays open on BFMR and the note says why.

export type BfmrLine = {
  reserveId: string | null;
  status: string;
  qty: number;
  retailPrice: number | null;
  bfmrOrderId: string | null;
  links: { orderId: number; quantity: number }[];
};

export type BfmrCancelPlan = {
  /** Reserve ids that pass every check. */
  cancel: string[];
  /** Why the others stay open, one entry per reservation. */
  left: string[];
};

const CANCELLABLE = new Set(['reserved', 'purchased']);

export const PRICE_LOW = 0.85;
export const PRICE_HIGH = 1.15;

const norm = (s: string | null | undefined) => String(s ?? '').replace(/[^0-9a-z]/gi, '').toUpperCase();

export function planBfmrCancel(order: { id: number; orderNumber: string | null; cost: number | null }, lines: readonly BfmrLine[]): BfmrCancelPlan {
  const plan: BfmrCancelPlan = { cancel: [], left: [] };
  const mine = lines.filter(l => l.links.some(k => k.orderId === order.id));
  if (!mine.length) return plan;

  const groups = new Map<string, BfmrLine[]>();
  for (const l of lines) {
    if (!l.reserveId) continue;
    groups.set(l.reserveId, [...(groups.get(l.reserveId) ?? []), l]);
  }
  for (const l of mine) if (!l.reserveId) plan.left.push('no BFMR reservation id on file');

  const orderNo = norm(order.orderNumber);
  const passing: string[] = [];
  let retail = 0;
  let priced = true;
  for (const [reserveId, group] of groups) {
    if (!group.some(l => l.links.some(k => k.orderId === order.id))) continue;
    const reason = groupProblem(order.id, orderNo, group);
    if (reason) { plan.left.push(reason); continue; }
    passing.push(reserveId);
    for (const l of group) {
      if (l.retailPrice == null || !(l.retailPrice > 0)) priced = false;
      else retail += l.retailPrice * l.qty;
    }
  }
  if (!passing.length) return plan;

  const cost = order.cost ?? 0;
  if (!priced || !(cost > 0)) {
    plan.left.push(...passing.map(() => 'no price to compare'));
    return plan;
  }
  const ratio = cost / retail;
  if (ratio < PRICE_LOW || ratio > PRICE_HIGH) {
    plan.left.push(...passing.map(() => `price doesn't match ($${cost.toFixed(2)} paid vs $${retail.toFixed(2)} retail)`));
    return plan;
  }
  plan.cancel = passing;
  return plan;
}

function groupProblem(orderId: number, orderNo: string, group: readonly BfmrLine[]): string | null {
  const bad = group.find(l => !CANCELLABLE.has(l.status));
  if (bad) return `it is ${bad.status} on BFMR`;
  if (group.some(l => l.links.some(k => k.orderId !== orderId))) return 'part of it is linked to another order';
  const linked = group.reduce((n, l) => n + l.links.reduce((m, k) => m + (k.orderId === orderId ? k.quantity : 0), 0), 0);
  const qty = group.reduce((n, l) => n + l.qty, 0);
  if (linked !== qty) return `only ${linked} of ${qty} reserved units are this order's`;
  for (const l of group) {
    const theirs = norm(l.bfmrOrderId);
    if (theirs && theirs !== orderNo) return 'BFMR has a different order number on it';
    if (!theirs && l.status === 'purchased') return 'BFMR has it as purchased with no order number';
  }
  return null;
}
