// Desired-state posting for orders. Pure: given an order's current state (plus
// the dates its events were first seen), compute the journal entries it should
// have, keyed by sourceKey. The reconciler diffs that against what is posted.
//
// Sales tax: P0 posts `cost` as-is (see the spec); no separate tax line.
import { formatOrderDateIso } from '../formatOrderDate.ts';
import { cents } from './money.ts';
import { laDay } from './dates.ts';
import type { Business, LineInput } from './types.ts';
import type { DesiredEntry } from './desired.ts';

export type GiftCardForBooks = {
  ccSubmittedAt: Date | string | null;
  ccPaymentStatus: string | null;
  ccPaymentDueAt: Date | string | null;
};

export type ReturnForBooks = {
  id: number;
  status: string;
  quantity: number;
  refundAmount: number | null;
  refundedAt?: Date | string | null;
};

export type OrderForBooks = {
  id: number;
  platform: string;
  orderDate: Date | string;
  cost: number;
  shippingCost: number;
  insuranceCost?: number | null;
  returnedCost?: number | null;
  salePrice: number | null;
  salePriceSynced?: boolean;
  buyerId: number | null;
  cardId: number | null;
  cashbackAmount: number;
  portalCashback: number | null;
  amexOfferDollars: number | null;
  bgPaidAmount: number | null;
  bfmrStatus: string | null;
  lost: boolean;
  cancelled: boolean;
  ignoredByRule: boolean;
  giftCards: GiftCardForBooks[];
  returns: ReturnForBooks[];
};

export type OrderCtx = {
  goLive: string; // 'YYYY-MM-DD'
  now: Date;
  /** event -> 'YYYY-MM-DD' (already stamped) */
  events: Map<string, string>;
  /** Inventory the opening entry carried for this order, if any. */
  openingInv?: number | null;
};

export const KNOWN_REFUND = '[known:refund]';
export const KNOWN_SHORTFALL = '[known:shortfall]';
export const isKnownTag = (memo: string | null | undefined) => !!memo && memo.startsWith('[known:');

const BIZ: Business = 'resell';

export function isGiftCardOrder(o: Pick<OrderForBooks, 'platform' | 'giftCards'>): boolean {
  return o.giftCards.length > 0 || /gift|cardcenter|mgcp/i.test(o.platform);
}

const toTime = (v: Date | string | null | undefined) => (v == null ? null : new Date(v).getTime());

/** CardCenter payment counts as received when Completed, or Waiting past its due date. */
export function giftPaymentReceived(o: Pick<OrderForBooks, 'giftCards'>, now: Date): boolean {
  const submitted = o.giftCards.filter(c => c.ccSubmittedAt != null);
  if (submitted.length === 0) return false;
  return submitted.every(c => {
    if (c.ccPaymentStatus === 'Completed') return true;
    const due = toTime(c.ccPaymentDueAt);
    return c.ccPaymentStatus === 'Waiting' && due != null && due <= now.getTime();
  });
}

export function orderDay(o: Pick<OrderForBooks, 'orderDate'>): string {
  return formatOrderDateIso(o.orderDate);
}

export type OrderState = { sold: boolean; paid: boolean; finalPay: boolean; lost: boolean };

export function orderState(o: OrderForBooks, now: Date): OrderState {
  const gift = isGiftCardOrder(o);
  const giftDone = gift && giftPaymentReceived(o, now);
  const sold = o.salePrice != null && (!gift || giftDone);
  const status = (o.bfmrStatus ?? '').toLowerCase();
  const paid = sold && (giftDone || o.bgPaidAmount != null || status === 'paid');
  const finalPay = paid && (giftDone || !!o.salePriceSynced || status === 'paid' || status === 'complete' || status === 'completed');
  return { sold, paid, finalPay, lost: o.lost && !sold };
}

/** Events that are true right now; the reconciler stamps new ones with today's date. */
export function eventsReached(o: OrderForBooks, now: Date): string[] {
  if (o.cancelled || o.ignoredByRule) return [];
  const st = orderState(o, now);
  const out: string[] = [];
  if (st.sold) out.push('sold');
  if (st.paid) out.push('paid');
  if (st.lost) out.push('lost');
  for (const r of o.returns) if (r.status === 'refunded') out.push(`refunded:${r.id}`);
  return out;
}

export function stampDate(now: Date): string {
  return laDay(now);
}

/** Each non-rejected return's share of Order.returnedCost, by quantity, summing to exactly the total. */
export function returnShares(o: OrderForBooks): Map<number, number> {
  const R = cents(o.returnedCost);
  const live = o.returns.filter(r => r.status !== 'rejected').sort((a, b) => a.id - b.id);
  const W = live.reduce((s, r) => s + Math.max(r.quantity, 0), 0);
  const out = new Map<number, number>();
  if (W <= 0) return out;
  let cum = 0;
  let prev = 0;
  for (const r of live) {
    cum += Math.max(r.quantity, 0);
    const upTo = Math.round((R * cum) / W);
    out.set(r.id, upTo - prev);
    prev = upTo;
  }
  return out;
}

function line(account: string, amountCents: number, orderId: number, memo?: string): LineInput {
  return { account, amountCents, orderId, business: BIZ, memo: memo ?? null };
}

/** The entries this order should have right now. Empty for cancelled / ignored orders. */
export function desiredOrderEntries(o: OrderForBooks, ctx: OrderCtx): DesiredEntry[] {
  if (o.cancelled || o.ignoredByRule) return [];
  const out: DesiredEntry[] = [];
  const st = orderState(o, ctx.now);
  const gift = isGiftCardOrder(o);
  const inv = gift ? 'inventory_giftcards' : 'inventory_goods';
  const cogs = gift ? 'cogs_giftcards' : 'cogs_goods';
  const cardAcct = o.cardId != null ? `card:${o.cardId}` : 'card_unassigned';
  const buyerAcct = o.buyerId != null ? `buyer:${o.buyerId}` : 'ar_unassigned';
  const day = orderDay(o);
  const pre = day < ctx.goLive; // carried by the opening entry
  const B = cents((o.cost ?? 0) + (o.shippingCost ?? 0) + (o.insuranceCost ?? 0));
  const cb = cents(o.cashbackAmount);
  const pc = cents(o.portalCashback);
  const ax = cents(o.amexOfferDollars);
  const C = cb + pc + ax;
  const S = o.salePrice == null ? null : cents(o.salePrice);
  const id = o.id;
  const label = `${o.platform} order ${id}`;
  const shares = returnShares(o);
  const refundedPosted = o.returns
    .filter(r => r.status === 'refunded')
    .filter(r => ctx.events.has(`refunded:${r.id}`) && ctx.events.get(`refunded:${r.id}`)! >= ctx.goLive);

  // 1. Purchase
  if (!pre && B !== 0) {
    out.push({
      sourceKey: `order:${id}:purchase`, date: day, memo: `Purchase, ${label}`, source: 'order',
      lines: [line(inv, B, id), line(cardAcct, -B, id)],
    });
  }

  // 2. Cashback (credit side follows sold state; amounts re-post when edited)
  if (!pre && C !== 0) {
    const lines: LineInput[] = [];
    if (cb) lines.push(line('cashback_card_recv', cb, id));
    if (pc) lines.push(line('cashback_portal_recv', pc, id));
    if (ax) lines.push(line('amex_offer_recv', ax, id));
    lines.push(line(st.sold ? cogs : inv, -C, id));
    out.push({ sourceKey: `order:${id}:cashback`, date: day, memo: `Cashback, ${label}`, source: 'order', lines });
  }

  // Inventory the order still carries while unsold.
  const baseInv = pre ? (ctx.openingInv ?? Math.max(B - C, 0)) : B - C;

  // 3. Sale
  const saleDate = ctx.events.get('sold');
  if (st.sold && S != null && saleDate && saleDate >= ctx.goLive) {
    const X = pre ? (ctx.openingInv ?? Math.max(B - C, 0)) : B;
    const lines = [line(buyerAcct, S, id), line('sales_resell', -S, id)];
    if (X !== 0) { lines.push(line(cogs, X, id), line(inv, -X, id)); }
    out.push({ sourceKey: `order:${id}:sale`, date: saleDate, memo: `Sale, ${label}`, source: 'order', lines });
  }

  // 4. Paid
  const paidDate = ctx.events.get('paid');
  if (st.paid && S != null && paidDate && paidDate >= ctx.goLive) {
    const P = o.bgPaidAmount != null ? cents(o.bgPaidAmount) : S;
    const lines = [line('undeposited_payouts', P, id), line(buyerAcct, -P, id)];
    if (st.finalPay) {
      const d = S - P;
      if (d > 0) lines.push(line('returns_allowances', d, id, KNOWN_SHORTFALL), line(buyerAcct, -d, id));
      else if (d < 0) lines.push(line(buyerAcct, -d, id), line('other_income', d, id, KNOWN_SHORTFALL));
    }
    out.push({ sourceKey: `order:${id}:paid`, date: paidDate, memo: `Payout, ${label}`, source: 'order', lines });
  }

  // 5. Returns refunded
  for (const r of refundedPosted) {
    const date = ctx.events.get(`refunded:${r.id}`)!;
    const refund = cents(r.refundAmount);
    const share = shares.get(r.id) ?? 0;
    const lines = [line(cardAcct, refund, id), line(st.sold ? cogs : inv, -share, id)];
    const diff = share - refund; // balances the entry
    if (diff < 0) lines.push(line('other_income', diff, id, KNOWN_REFUND));
    else if (diff > 0) lines.push(line('exp_other', diff, id, KNOWN_REFUND));
    out.push({ sourceKey: `order:${id}:return:${r.id}`, date, memo: `Return refunded, ${label}`, source: 'order', lines });
  }

  // 6. Lost (no sale)
  const lostDate = ctx.events.get('lost');
  if (st.lost && lostDate && lostDate >= ctx.goLive) {
    // Unsold, so refunds credited inventory; what is left is the loss.
    const credited = refundedPosted.reduce((s, r) => s + (shares.get(r.id) ?? 0), 0);
    const remaining = baseInv - credited;
    if (remaining > 0) {
      out.push({
        sourceKey: `order:${id}:lost`, date: lostDate, memo: `Lost, ${label}`, source: 'order',
        lines: [line('inventory_loss', remaining, id), line(inv, -remaining, id)],
      });
    }
  }

  return out.filter(e => e.lines.some(l => l.amountCents !== 0));
}
