// Which tracker order a PayPal receipt belongs to. Pure, no I/O: the caller
// loads the user's orders and decides what to do with the answer.
//
// A receipt names a merchant ("Lenovo Corporation"), an amount and a date, but
// not the retailer's order number, so the order is found by:
//   - the merchant name containing the order's platform ("Lenovo"), any case;
//   - the amount within a couple of cents of cost, cost + tax, or
//     cost + tax + shipping;
//   - the order date within 3 days of the receipt date.
// Orders whose notes already carry a different PayPal transaction id are skipped
// (that payment is taken), and one that carries this id means the receipt has
// been applied already.

import type { PayPalReceipt } from './paypalReceipt.ts';

export type PayPalOrder = {
  id: number;
  platform: string;
  cost: number;
  taxAmount: number | null;
  shippingCost: number;
  orderDate: Date | string;
  createdAt: Date | string;
  notes: string | null;
  cancelled: boolean;
};

export const AMOUNT_TOLERANCE = 0.02;
export const DATE_WINDOW_DAYS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

export type PayPalMatch =
  | { action: 'done'; orderId: number }    // the order's notes already carry this transaction id
  | { action: 'apply'; orderId: number }
  | { action: 'wait' }                     // no order yet, and the receipt is young
  | { action: 'no-matching-order' };

const TXN_IN_NOTES_RE = /\(transaction ([A-Z0-9]{6,})\)/gi;

/** PayPal transaction ids written into `notes` by an earlier match. */
export function paypalTxnIds(notes: string | null | undefined): string[] {
  return [...String(notes ?? '').matchAll(TXN_IN_NOTES_RE)].map(m => m[1].toUpperCase());
}

const ms = (d: Date | string) => (d instanceof Date ? d : new Date(d)).getTime();
const utcDay = (t: number) => Math.floor(t / DAY_MS);

/** The amounts a PayPal charge for this order could be: cost, with tax, with tax and shipping. */
export function chargeCandidates(o: Pick<PayPalOrder, 'cost' | 'taxAmount' | 'shippingCost'>): number[] {
  const tax = o.taxAmount ?? 0;
  return [o.cost, o.cost + tax, o.cost + tax + (o.shippingCost ?? 0)];
}

function qualifies(r: PayPalReceipt, o: PayPalOrder, receiptAt: number): boolean {
  const platform = o.platform.trim().toLowerCase();
  if (!platform || !r.merchant.toLowerCase().includes(platform)) return false;
  if (!chargeCandidates(o).some(c => Math.abs(c - r.amount) <= AMOUNT_TOLERANCE + 1e-9)) return false;
  const orderAt = ms(o.orderDate);
  if (!Number.isFinite(orderAt)) return false;
  return Math.abs(utcDay(orderAt) - utcDay(receiptAt)) <= DATE_WINDOW_DAYS;
}

/**
 * What to do with a receipt. `receiptAt` is when the receipt happened (its
 * Transaction date when it has one, else the email's date); `emailAt` is the
 * email's date and times the wait. `waitMs` is how long a receipt with no
 * order waits before it is flagged.
 */
export function matchPayPalReceipt(
  r: PayPalReceipt,
  orders: readonly PayPalOrder[],
  ctx: { emailAt: Date | string; now: number; waitMs: number },
): PayPalMatch {
  const live = orders.filter(o => !o.cancelled);
  const mine = r.txnId.toUpperCase();
  const applied = live.find(o => paypalTxnIds(o.notes).includes(mine));
  if (applied) return { action: 'done', orderId: applied.id };

  const emailAt = ms(ctx.emailAt);
  const receiptAt = r.date ? Date.parse(`${r.date}T12:00:00Z`) : emailAt;
  const candidates = Number.isFinite(receiptAt)
    ? live.filter(o => paypalTxnIds(o.notes).length === 0 && qualifies(r, o, receiptAt))
    : [];
  if (candidates.length) {
    // Two orders for the same thing at the same price: the one created
    // nearest the receipt is the one it paid for.
    const ref = Number.isFinite(emailAt) ? emailAt : receiptAt;
    const best = [...candidates].sort((a, b) => Math.abs(ms(a.createdAt) - ref) - Math.abs(ms(b.createdAt) - ref) || a.id - b.id)[0];
    return { action: 'apply', orderId: best.id };
  }

  const age = ctx.now - (Number.isFinite(emailAt) ? emailAt : receiptAt);
  // An undated receipt can't be timed, so it's flagged straight away.
  return Number.isFinite(age) && age <= ctx.waitMs ? { action: 'wait' } : { action: 'no-matching-order' };
}
