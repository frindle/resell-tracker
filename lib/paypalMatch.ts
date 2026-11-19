// Which tracker order a PayPal receipt belongs to. Pure, no I/O: the caller
// loads the user's orders and decides what to do with the answer.
//
// The order is found by:
//   1. the order/invoice number the receipt shows, when it equals exactly one
//      order's number (compared without punctuation, any case);
//   2. otherwise merchant + amount + date: the merchant name containing the
//      order's platform ("Lenovo"), any case; the amount within a couple of
//      cents of cost, cost + tax, or cost + tax + shipping; the order date
//      within 3 days of the receipt date.
// Exactly one order or nothing: several fits is a hold, never a guess. A locked
// order is never written to. A receipt waits up to 7 days for its order, then
// gives up (the caller archives it).
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
  orderNumber: string | null;
  /** Order.locked: someone confirmed this order's values; no sync writes to it. */
  locked: boolean;
};

export const AMOUNT_TOLERANCE = 0.02;
export const DATE_WINDOW_DAYS = 3;
/** How long a receipt waits for its order to appear before it is given up on. */
export const PAYPAL_WAIT_MS = 7 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export type PayPalMatch =
  | { action: 'done'; orderId: number }    // the order's notes already carry this transaction id
  | { action: 'apply'; orderId: number }
  | { action: 'hold'; reason: 'waiting-for-order' | 'ambiguous' | 'locked-order' } // keep in the inbox, try again next run
  | { action: 'give-up' };                 // older than the wait and still nothing to write: archive it

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

const alnum = (s: string | null | undefined) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * What to do with a receipt. `receiptAt` is when the receipt happened (its
 * Transaction date when it has one, else the email's date); `emailAt` is the
 * email's date and times the wait. `waitMs` is how long a receipt with no
 * usable order waits before it is given up on (PAYPAL_WAIT_MS).
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
  const open = live.filter(o => paypalTxnIds(o.notes).length === 0);

  // 1. The merchant's order/invoice number.
  const ref = alnum(r.orderRef);
  const byNumber = ref.length >= 4 ? open.filter(o => alnum(o.orderNumber) === ref) : [];
  // 2. Merchant + amount + date.
  const fits = byNumber.length ? byNumber : Number.isFinite(receiptAt) ? open.filter(o => qualifies(r, o, receiptAt)) : [];

  const age = ctx.now - (Number.isFinite(emailAt) ? emailAt : receiptAt);
  const young = Number.isFinite(age) && age <= ctx.waitMs;
  // An undated receipt can't be timed, so it is not held for long.
  const hold = (reason: 'waiting-for-order' | 'ambiguous' | 'locked-order'): PayPalMatch =>
    young ? { action: 'hold', reason } : { action: 'give-up' };

  if (fits.length === 1) return fits[0].locked ? hold('locked-order') : { action: 'apply', orderId: fits[0].id };
  if (fits.length > 1) return hold('ambiguous');
  return hold('waiting-for-order');
}
