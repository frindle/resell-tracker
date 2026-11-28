// Paid orders and what their deposits have cleared (Books P3 step 3c). Reads only.
import { prisma } from '../../db';
import { loadOrders, getGoLive, readOpeningInput, todayLA } from '../service.ts';
import { orderState, orderDay, depositPaidDay } from '../orderPostings.ts';
import { PrismaStore } from '../prismaStore.ts';
import { cents } from '../money.ts';
import { clearedByOrder, agingByBuyer, isPreFeed, goLiveCheckSum, inGoLiveWindow, goLiveCheckStart, type PayoutLink } from '../payoutReview.ts';
import type { MatchPayout, MatchGroupPayment } from '../match.ts';
import { bfmrBatches, commonBuyerId, dayOf, type BfmrBatch, type BfmrPaidRes } from '../../groupPaymentDay.ts';

export type PayoutOrder = MatchPayout & {
  orderNumber: string | null; platform: string; itemDescription: string | null; buyerName: string | null;
  orderDay: string; saleCents: number; finalPay: boolean;
  /** Paid more than 30 days before the bank history starts: its deposit predates the feed and can never be linked. */
  preFeed: boolean;
};

export async function loadPayoutLinks(userId: number): Promise<PayoutLink[]> {
  const rows = await prisma.bankMatch.findMany({ where: { userId, kind: { in: ['payout', 'payout_shortfall'] } } });
  return rows.map(r => ({ txnId: r.txnId, kind: r.kind, refId: r.refId, amountCents: r.amountCents, note: r.note }));
}

const BFMR_BATCH_DAYS = 200;

/**
 * BFMR's payment batches, derived from the reservations the BFMR sync already stored (no table, no API call): every reservation
 * with a paid date in the last 200 days, grouped by that day, amounts from the item's own amount_paid (raw JSON) with total_payout
 * only where amount_paid is absent, spread over the orders each is linked to. Also what BFMR actually paid per order.
 */
export async function loadBfmrPaid(userId: number, now = new Date()): Promise<{ batches: (BfmrBatch & { buyerId: number | null })[]; paidByOrder: Map<number, number> }> {
  const since = new Date(now.getTime() - BFMR_BATCH_DAYS * 86400000);
  const rows = await prisma.bfmrReservation.findMany({
    where: { userId, datePaid: { gte: since } },
    select: { id: true, qty: true, datePaid: true, totalPayout: true, raw: true, orderLinks: { select: { orderId: true, quantity: true } } },
  });
  const rs: BfmrPaidRes[] = [];
  for (const r of rows) {
    let rawPaid: unknown = null, rawDay: string | null = null;
    try { const j = r.raw ? JSON.parse(r.raw) as Record<string, unknown> : {}; rawPaid = j.amount_paid; rawDay = dayOf(typeof j.date_paid === 'string' ? j.date_paid : null); } catch { /* no raw */ }
    const day = rawDay ?? (r.datePaid ? r.datePaid.toISOString().slice(0, 10) : null);
    if (!day) continue;
    const n = parseFloat(String(rawPaid ?? '').replace(/,/g, ''));
    rs.push({ id: r.id, qty: r.qty, day, amountPaid: Number.isNaN(n) ? null : n, totalPayout: r.totalPayout, links: r.orderLinks });
  }
  const { batches, paidByOrder } = bfmrBatches(rs);
  const ids = [...new Set(batches.flatMap(b => b.orders.map(o => o.orderId)))];
  const buyerBy = new Map((await prisma.order.findMany({ where: { userId, id: { in: ids } }, select: { id: true, buyerId: true } })).map(o => [o.id, o.buyerId]));
  return { batches: batches.map(b => ({ ...b, buyerId: commonBuyerId(b.orders.map(o => buyerBy.get(o.orderId) ?? null)) })), paidByOrder };
}

/** The groups' own payments (stored by their syncs, plus BFMR's derived batches) with the orders each paid, for the deposit matcher. */
export async function loadGroupPayments(userId: number): Promise<MatchGroupPayment[]> {
  const rows = await prisma.groupPayment.findMany({ where: { userId }, include: { orders: true } });
  const bfmr = (await loadBfmrPaid(userId)).batches;
  const ids = [...new Set([...rows.map(r => r.buyerId), ...bfmr.map(b => b.buyerId)].filter((b): b is number => b != null))];
  const names = new Map((await prisma.buyer.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })).map(b => [b.id, b.name]));
  const derived: MatchGroupPayment[] = bfmr.map((b, i) => ({
    id: -(i + 1), group: 'bfmr', ref: b.ref, buyerId: b.buyerId, buyerName: b.buyerId != null ? names.get(b.buyerId) ?? null : null,
    paidDay: b.day, amountCents: b.amountCents, orders: b.orders,
  }));
  return [...rows.map(r => ({
    id: r.id, group: r.group, ref: `${r.group}:${r.externalRef}`, buyerId: r.buyerId, buyerName: r.buyerId != null ? names.get(r.buyerId) ?? null : null, paidDay: r.paidDate, amountCents: r.amountCents,
    orders: r.orders.map(o => ({ orderId: o.orderId, cents: o.amountCents })),
  })), ...derived];
}

/** First posted day of any bank row on the user's mapped deposit accounts (null when there are none). */
export async function bankFeedStart(userId: number): Promise<string | null> {
  const r = await prisma.bankTransaction.aggregate({ where: { userId, account: { ledgerAccountId: { not: null }, hidden: false } }, _min: { postedDate: true } });
  return r._min.postedDate ?? null;
}

/** Every paid order with its open amount (paid amount less payout / fee / returns links). Paid day: see depositPaidDay. */
export async function loadPayoutOrders(userId: number, now = new Date()): Promise<{ all: PayoutOrder[]; links: PayoutLink[]; goLive: string; feedStart: string | null }> {
  const [orders, links, goLive, feedStart] = await Promise.all([loadOrders(userId), loadPayoutLinks(userId), getGoLive(userId), bankFeedStart(userId)]);
  const paid = orders.filter(o => !o.cancelled && !o.ignoredByRule && o.salePrice != null && orderState(o, now).paid);
  const ids = paid.map(o => o.id);
  const [stamps, meta, buyers, bfmrPaid] = await Promise.all([
    new PrismaStore().eventStamps(ids, 'paid'),
    prisma.order.findMany({ where: { userId, id: { in: ids } }, select: { id: true, orderNumber: true, platform: true, itemDescription: true } }),
    prisma.buyer.findMany({ select: { id: true, name: true } }),
    loadBfmrPaid(userId, now),
  ]);
  const metaBy = new Map(meta.map(m => [m.id, m])), buyerBy = new Map(buyers.map(b => [b.id, b.name]));
  const cleared = clearedByOrder(links);
  const all = paid.map(o => {
    const S = cents(o.salePrice!), P = o.bgPaidAmount != null ? cents(o.bgPaidAmount) : S;
    const m = metaBy.get(o.id);
    const paidDay = depositPaidDay(o, stamps.get(o.id), { goLive, now });
    const open = Math.max(0, P - (cleared.get(o.id) ?? 0));
    // BFMR: bgPaidAmount is its expected total_payout; amount_paid is what it paid. When that is less, searches count what was paid.
    const actual = bfmrPaid.paidByOrder.get(o.id);
    const payOpenCents = actual != null && actual < P ? Math.max(0, actual - (P - open)) : undefined;
    return {
      orderId: o.id, buyerId: o.buyerId, paidDay, paidCents: P, openCents: open,
      ...(payOpenCents != null ? { payOpenCents } : {}), groupPaid: actual != null || (o.bgPaidAmount != null && o.bgPaidAmount > 0),
      orderNumber: m?.orderNumber ?? null, platform: o.platform, itemDescription: m?.itemDescription ?? null,
      buyerName: o.buyerId != null ? buyerBy.get(o.buyerId) ?? null : null, orderDay: orderDay(o), saleCents: S, finalPay: orderState(o, now).finalPay, preFeed: isPreFeed(paidDay, feedStart),
    };
  });
  return { all, links, goLive, feedStart };
}

export type PreGoLiveCheck = {
  ordersCents: number; openingCents: number; differenceCents: number; orders: number;
  /** Orders paid before the bank history started (treated as deposited), left out of the sum. */
  preFeedOrders: number; preFeedCents: number; feedStart: string | null;
  goLive: string; checkStart: string; inWindow: boolean;
};

/**
 * One-time check for the Reconcile tab: orders dated before go-live that were paid before it but not yet deposited,
 * less deposits already linked on rows before go-live, against the opening's undepositedCents. Orders paid before the
 * bank history started are counted apart. The check only applies from 30 days before go-live (inWindow).
 */
export async function preGoLiveUndeposited(userId: number, now = new Date()): Promise<PreGoLiveCheck> {
  const { all, links, goLive, feedStart } = await loadPayoutOrders(userId, now);
  const early = await prisma.bankTransaction.findMany({ where: { userId, postedDate: { lt: goLive }, id: { in: [...new Set(links.map(l => l.txnId))] } }, select: { id: true } });
  const earlyIds = new Set(early.map(r => r.id));
  const clearedEarly = clearedByOrder(links.filter(l => earlyIds.has(l.txnId)));
  const sum = goLiveCheckSum(all, goLive, clearedEarly);
  const opening = (await readOpeningInput(userId)).undepositedCents ?? 0;
  return {
    ordersCents: sum.ordersCents, openingCents: opening, differenceCents: sum.ordersCents - opening, orders: sum.orders,
    preFeedOrders: sum.preFeedOrders, preFeedCents: sum.preFeedCents, feedStart,
    goLive, checkStart: goLiveCheckStart(goLive), inWindow: inGoLiveWindow(todayLA(), goLive),
  };
}

export { agingByBuyer };
