// Paid orders and what their deposits have cleared (Books P3 step 3c). Reads only.
import { prisma } from '../../db';
import { loadOrders, getGoLive, readOpeningInput } from '../service.ts';
import { orderState, bestEventDate, orderDay } from '../orderPostings.ts';
import { PrismaStore } from '../prismaStore.ts';
import { cents } from '../money.ts';
import { clearedByOrder, agingByBuyer, type PayoutLink } from '../payoutReview.ts';
import type { MatchPayout } from '../match.ts';

export type PayoutOrder = MatchPayout & {
  orderNumber: string | null; platform: string; itemDescription: string | null; buyerName: string | null;
  orderDay: string; saleCents: number; finalPay: boolean;
};

export async function loadPayoutLinks(userId: number): Promise<PayoutLink[]> {
  const rows = await prisma.bankMatch.findMany({ where: { userId, kind: { in: ['payout', 'payout_shortfall'] } } });
  return rows.map(r => ({ txnId: r.txnId, kind: r.kind, refId: r.refId, amountCents: r.amountCents, note: r.note }));
}

/** Every paid order with its open amount (paid amount less payout / fee / returns links). Paid day: the stamped 'paid' event. */
export async function loadPayoutOrders(userId: number, now = new Date()): Promise<{ all: PayoutOrder[]; links: PayoutLink[]; goLive: string }> {
  const [orders, links, goLive] = await Promise.all([loadOrders(userId), loadPayoutLinks(userId), getGoLive(userId)]);
  const paid = orders.filter(o => !o.cancelled && !o.ignoredByRule && o.salePrice != null && orderState(o, now).paid);
  const ids = paid.map(o => o.id);
  const [events, meta, buyers] = await Promise.all([
    new PrismaStore().eventDates(ids),
    prisma.order.findMany({ where: { userId, id: { in: ids } }, select: { id: true, orderNumber: true, platform: true, itemDescription: true } }),
    prisma.buyer.findMany({ select: { id: true, name: true } }),
  ]);
  const metaBy = new Map(meta.map(m => [m.id, m])), buyerBy = new Map(buyers.map(b => [b.id, b.name]));
  const cleared = clearedByOrder(links);
  const all = paid.map(o => {
    const S = cents(o.salePrice!), P = o.bgPaidAmount != null ? cents(o.bgPaidAmount) : S;
    const m = metaBy.get(o.id);
    const paidDay = events.get(o.id)?.get('paid') ?? bestEventDate(o, 'paid', { goLive, now, hasOpening: false }).date;
    return {
      orderId: o.id, buyerId: o.buyerId, paidDay, paidCents: P, openCents: Math.max(0, P - (cleared.get(o.id) ?? 0)),
      orderNumber: m?.orderNumber ?? null, platform: o.platform, itemDescription: m?.itemDescription ?? null,
      buyerName: o.buyerId != null ? buyerBy.get(o.buyerId) ?? null : null, orderDay: orderDay(o), saleCents: S, finalPay: orderState(o, now).finalPay,
    };
  });
  return { all, links, goLive };
}

export type PreGoLiveCheck = { ordersCents: number; openingCents: number; differenceCents: number; orders: number };

/**
 * One-time check for the Reconcile tab: orders dated before go-live that were paid before it but not yet deposited,
 * less deposits already linked on rows before go-live, against the opening's undepositedCents.
 */
export async function preGoLiveUndeposited(userId: number, now = new Date()): Promise<PreGoLiveCheck> {
  const { all, links, goLive } = await loadPayoutOrders(userId, now);
  const early = await prisma.bankTransaction.findMany({ where: { userId, postedDate: { lt: goLive }, id: { in: [...new Set(links.map(l => l.txnId))] } }, select: { id: true } });
  const earlyIds = new Set(early.map(r => r.id));
  const clearedEarly = clearedByOrder(links.filter(l => earlyIds.has(l.txnId)));
  let sum = 0, n = 0;
  for (const o of all) {
    if (o.orderDay >= goLive || o.paidDay >= goLive) continue;
    const left = o.paidCents - (clearedEarly.get(o.orderId) ?? 0);
    if (left > 0) { sum += left; n++; }
  }
  const opening = (await readOpeningInput(userId)).undepositedCents ?? 0;
  return { ordersCents: sum, openingCents: opening, differenceCents: sum - opening, orders: n };
}

export { agingByBuyer };
