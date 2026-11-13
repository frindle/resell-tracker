// Desired-state posting for orders. Pure: given an order's current state (plus
// the dates its events were first seen), compute the journal entries it should
// have, keyed by sourceKey. The reconciler diffs that against what is posted.
//
// Sales tax: P0 posts `cost` as-is (see the spec); no separate tax line.
import { formatOrderDateIso } from '../formatOrderDate.ts';
import { cents } from './money.ts';
import { laDay, dayBefore } from './dates.ts';
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
  /** BfmrReservation.datePaid of a linked reservation, when one exists. */
  bfmrPaidAt?: Date | string | null;
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

const dayOfDate = (v: Date | string | null | undefined): string | null => {
  if (v == null) return null;
  const t = new Date(v);
  return Number.isNaN(t.getTime()) ? null : laDay(t);
};

/** Real dates the data holds for an event (never updatedAt). Earliest wins. */
export function realEventDate(o: OrderForBooks, event: string): string | null {
  const c: (string | null)[] = [];
  if (event.startsWith('refunded:')) {
    const r = o.returns.find(x => x.id === Number(event.slice(9)));
    c.push(dayOfDate(r?.refundedAt));
  } else if (event === 'sold') {
    for (const g of o.giftCards) c.push(dayOfDate(g.ccSubmittedAt));
  } else if (event === 'paid') {
    for (const g of o.giftCards) c.push(dayOfDate(g.ccPaymentDueAt));
    c.push(dayOfDate(o.bfmrPaidAt));
  }
  const real = c.filter((x): x is string => x != null).sort();
  return real[0] ?? null;
}

export type Stamp = { date: string; inferred: boolean };

/**
 * The date a newly seen event is stamped with: the best real date, clamped to [order date, today].
 * No real date: an order dated before go-live counts as before go-live (go-live minus a day, inferred);
 * otherwise today. If an opening entry already carried the order as inventory, the event happened after it:
 * never before go-live.
 */
export function bestEventDate(o: OrderForBooks, event: string, ctx: { goLive: string; now: Date; hasOpening: boolean }): Stamp {
  const today = stampDate(ctx.now);
  const od = orderDay(o);
  const pre = od < ctx.goLive;
  let real = realEventDate(o, event);
  if (real != null) {
    if (real < od) real = od;
    if (real > today) real = today;
  }
  if (pre && ctx.hasOpening) {
    const d = real ?? today;
    return { date: d < ctx.goLive ? ctx.goLive : d, inferred: false };
  }
  if (real != null) return { date: real, inferred: false };
  if (pre) return { date: dayBefore(ctx.goLive), inferred: true };
  return { date: today, inferred: false };
}

export type CashbackObs = { seq: number; date: string; cb: number; pc: number; ax: number };
const CB_RE = /^cb:(\d+):(-?\d+):(-?\d+):(-?\d+)$/;

/** Cashback totals as observed over time (stamped as events `cb:<seq>:<cb>:<pc>:<ax>`), oldest first. */
export function cashbackObs(events: Map<string, string>): CashbackObs[] {
  const out: CashbackObs[] = [];
  for (const [k, date] of events) {
    const m = CB_RE.exec(k);
    if (m) out.push({ seq: Number(m[1]), date, cb: Number(m[2]), pc: Number(m[3]), ax: Number(m[4]) });
  }
  return out.sort((a, b) => a.seq - b.seq);
}

/**
 * Index of the observation the opening entry carries for a pre-go-live order: the last one seen before go-live
 * (the go-live baseline stamp is dated the day before, so this is at least 0). Later observations are deltas.
 */
export function cashbackBaselineIdx(obs: CashbackObs[], goLive: string): number {
  let idx = 0;
  obs.forEach((x, i) => { if (x.date < goLive) idx = i; });
  return idx;
}

const cbTriple = (o: OrderForBooks) => ({ cb: cents(o.cashbackAmount), pc: cents(o.portalCashback), ax: cents(o.amexOfferDollars) });

/**
 * A new cashback observation to stamp when the totals differ from the last one seen (null otherwise).
 * First sight: orders before go-live get a baseline dated go-live minus a day (the opening carries it);
 * later orders are dated the order date when the order is new to the books, else today (cashback that shows up on an
 * order already posted is a change observed now, never a rewrite of the order's month); also today when already sold. Changes are dated today.
 */
export function nextCashbackStamp(
  o: OrderForBooks, events: Map<string, string>, ctx: { goLive: string; now: Date; isNew?: boolean },
): { event: string; date: string; inferred: boolean } | null {
  if (o.cancelled || o.ignoredByRule) return null;
  const obs = cashbackObs(events);
  const cur = cbTriple(o);
  const pre = orderDay(o) < ctx.goLive;
  const name = (seq: number) => `cb:${seq}:${cur.cb}:${cur.pc}:${cur.ax}`;
  if (obs.length === 0) {
    if (!pre && cur.cb === 0 && cur.pc === 0 && cur.ax === 0) return null;
    if (pre) return { event: name(0), date: dayBefore(ctx.goLive), inferred: true };
    const sold = events.has('sold');
    return { event: name(0), date: sold || ctx.isNew === false ? stampDate(ctx.now) : orderDay(o), inferred: false };
  }
  const last = obs[obs.length - 1];
  if (last.cb === cur.cb && last.pc === cur.pc && last.ax === cur.ax) return null;
  return { event: name(last.seq + 1), date: stampDate(ctx.now), inferred: false };
}

/**
 * Each non-rejected return's share of Order.returnedCost, summing to exactly the total. Weights follow
 * returnedCostFor (lib/orderReturns.ts): the refund amount for a return that has one, else the per-unit cost
 * times its quantity, where the per-unit cost is what is left of returnedCost over the in-flight units.
 * Falls back to a quantity split when no weight is known.
 */
export function returnShares(o: OrderForBooks): Map<number, number> {
  const R = cents(o.returnedCost);
  const live = o.returns.filter(r => r.status !== 'rejected').sort((a, b) => a.id - b.id);
  const out = new Map<number, number>();
  if (live.length === 0) return out;
  const qty = (r: ReturnForBooks) => Math.max(r.quantity, 0);
  const refundedC = live.reduce((s, r) => s + (r.refundAmount != null ? cents(r.refundAmount) : 0), 0);
  const inflightQty = live.reduce((s, r) => s + (r.refundAmount == null ? qty(r) : 0), 0);
  const perUnit = inflightQty > 0 ? Math.max(R - refundedC, 0) / inflightQty : 0;
  let weights = live.map(r => (r.refundAmount != null ? cents(r.refundAmount) : perUnit * qty(r)));
  let W = weights.reduce((s, w) => s + w, 0);
  if (W <= 0) { weights = live.map(qty); W = weights.reduce((s, w) => s + w, 0); }
  if (W <= 0) return out;
  let cum = 0;
  let prev = 0;
  live.forEach((r, i) => {
    cum += weights[i];
    const upTo = Math.round((R * cum) / W);
    out.set(r.id, upTo - prev);
    prev = upTo;
  });
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
  const S = o.salePrice == null ? null : cents(o.salePrice);
  const id = o.id;
  const label = `${o.platform} order ${id}`;
  const shares = returnShares(o);
  const saleDate = st.sold ? ctx.events.get('sold') ?? null : null;
  const lostDate = st.lost ? ctx.events.get('lost') ?? null : null;
  // Where a credit that arrives on `date` goes: the order's state as of that date, never a past period.
  const creditAt = (date: string) => (saleDate && saleDate <= date ? cogs : lostDate && lostDate <= date ? 'inventory_loss' : inv);
  const refundedPosted = o.returns
    .filter(r => r.status === 'refunded')
    .filter(r => ctx.events.has(`refunded:${r.id}`) && ctx.events.get(`refunded:${r.id}`)! >= ctx.goLive);

  // Cashback as a series of immutable deltas between observations. Orders before go-live: the first
  // observation is the baseline the opening entry carried, later ones post.
  let obs = cashbackObs(ctx.events);
  if (obs.length === 0) { const t = cbTriple(o); obs = [{ seq: 0, date: pre ? dayBefore(ctx.goLive) : day, ...t }]; }
  const baseIdx = pre ? cashbackBaselineIdx(obs, ctx.goLive) : -1;
  const baseline = pre ? obs[baseIdx] : { cb: 0, pc: 0, ax: 0 };
  const baseC = baseline.cb + baseline.pc + baseline.ax;
  const deltas: { seq: number; date: string; cb: number; pc: number; ax: number }[] = [];
  for (let i = pre ? baseIdx + 1 : 0; i < obs.length; i++) {
    const prev = i === 0 ? { cb: 0, pc: 0, ax: 0 } : obs[i - 1];
    // Nothing posts before go-live: a change observed earlier is dated go-live at the earliest.
    deltas.push({ seq: obs[i].seq, date: obs[i].date < ctx.goLive ? ctx.goLive : obs[i].date, cb: obs[i].cb - prev.cb, pc: obs[i].pc - prev.pc, ax: obs[i].ax - prev.ax });
  }

  // 1. Purchase
  if (!pre && B !== 0) {
    out.push({
      sourceKey: `order:${id}:purchase`, date: day, memo: `Purchase, ${label}`, source: 'order',
      lines: [line(inv, B, id), line(cardAcct, -B, id)],
    });
  }

  // 2. Cashback deltas
  for (const dl of deltas) {
    const tot = dl.cb + dl.pc + dl.ax;
    if (tot === 0 && dl.cb === 0 && dl.pc === 0 && dl.ax === 0) continue;
    const lines: LineInput[] = [];
    if (dl.cb) lines.push(line('cashback_card_recv', dl.cb, id));
    if (dl.pc) lines.push(line('cashback_portal_recv', dl.pc, id));
    if (dl.ax) lines.push(line('amex_offer_recv', dl.ax, id));
    lines.push(line(creditAt(dl.date), -tot, id));
    out.push({ sourceKey: `order:${id}:cashback:${dl.seq}`, date: dl.date, memo: `Cashback, ${label}`, source: 'order', lines });
  }

  // Inventory this order carries when the sale / loss happens: what it started with, less credits that
  // went to inventory (cashback and refunds dated before that point).
  const startInv = pre ? (ctx.openingInv ?? Math.max(B - baseC, 0)) : B;
  const invCredits = deltas.reduce((t, dl) => t + (creditAt(dl.date) === inv ? dl.cb + dl.pc + dl.ax : 0), 0)
    + refundedPosted.reduce((t, r) => t + (creditAt(ctx.events.get(`refunded:${r.id}`)!) === inv ? (shares.get(r.id) ?? 0) : 0), 0);
  const carried = startInv - invCredits;

  // 3. Sale
  if (st.sold && S != null && saleDate && saleDate >= ctx.goLive) {
    const X = carried;
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

  // 5. Returns refunded, at the stamped refund date; the credit follows the order's state as of that date
  for (const r of refundedPosted) {
    const date = ctx.events.get(`refunded:${r.id}`)!;
    const refund = cents(r.refundAmount);
    const share = shares.get(r.id) ?? 0;
    const lines = [line(cardAcct, refund, id), line(creditAt(date), -share, id)];
    const diff = share - refund; // balances the entry
    if (diff < 0) lines.push(line('other_income', diff, id, KNOWN_REFUND));
    else if (diff > 0) lines.push(line('exp_other', diff, id, KNOWN_REFUND));
    out.push({ sourceKey: `order:${id}:return:${r.id}`, date, memo: `Return refunded, ${label}`, source: 'order', lines });
  }

  // 6. Lost (no sale): what is left in inventory at the loss date
  if (st.lost && lostDate && lostDate >= ctx.goLive) {
    if (carried > 0) {
      out.push({
        sourceKey: `order:${id}:lost`, date: lostDate, memo: `Lost, ${label}`, source: 'order',
        lines: [line('inventory_loss', carried, id), line(inv, -carried, id)],
      });
    }
  }

  return out.filter(e => e.lines.some(l => l.amountCents !== 0));
}
