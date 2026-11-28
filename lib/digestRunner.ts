import { prisma } from './db';
import { buildDigestLines, daysToPost, dayWindow, postDigestLines, type DigestCounts } from './digestLines';
import { resetRanges, type ResetItem, type ResetOrder } from './resetLines.ts';
import { gated } from './primaryFlag.ts';
import { classifyActionOrders, ACTION_WINDOW_DAYS, type ActionGroups, type ActionOrder, type ActionDelivery } from './orderActions.ts';
import { openDepositShortfalls } from './books/payoutReview.ts';
import { loadDeliveryVsReceived } from './deliveryVsReceivedDb';
import { OPEN_RETURN_STATUSES } from './returnStatus.ts';

// Hourly: posts count-only lines for the homelab digest email's "Resell"
// section (see lib/digestLines.ts). Does nothing unless DIGEST_QUEUE_URL and
// DIGEST_QUEUE_TOKEN are both set. Counts cover every user; this is a
// one-household install.

const TICK_MS = 60 * 60 * 1000;

// "Waiting on tracking" uses the same rule as the deadline Pushover
// (lib/deadlineReminders.ts), minus cancelled orders.
const waitingToShip = {
  deliveryDeadline: { not: null },
  lost: false,
  salePriceSynced: false,
  cancelled: false,
  OR: [{ trackingNumbers: null }, { trackingNumbers: '' }],
};

// Orders whose purchase limit resets on the day after `day` (see lib/resetLines.ts). Amazon and Walmart count
// from the order time, Costco from the eGift email's delivery time. Per-item titles come from the Amazon
// package captures when they have them.
export async function resetOrdersFor(day: string): Promise<ResetOrder[]> {
  const r = resetRanges(day);
  const rows = await prisma.order.findMany({
    where: {
      cancelled: false,
      OR: [
        { platform: 'Amazon', orderedAt: { gte: r.Amazon.from, lt: r.Amazon.to } },
        { platform: 'Walmart', orderedAt: { gte: r.Walmart.from, lt: r.Walmart.to } },
        { platform: 'Costco', egiftDeliveredAt: { gte: r.Costco.from, lt: r.Costco.to } },
      ],
    },
    select: {
      platform: true, itemDescription: true, cancelled: true, orderedAt: true, egiftDeliveredAt: true,
      packages: { where: { itemsKnown: true }, select: { itemsJson: true } },
    },
  });
  return rows.map(o => {
    const items: ResetItem[] = [];
    for (const p of o.packages) {
      try {
        const list = JSON.parse(p.itemsJson);
        if (Array.isArray(list)) for (const i of list) if (i && typeof i.title === 'string' && Number(i.quantity) > 0) items.push({ title: i.title, quantity: Number(i.quantity), qtyAssumed: !!i.qtyAssumed });
      } catch { /* a bad capture: the description is used */ }
    }
    return { platform: o.platform, itemDescription: o.itemDescription, cancelled: o.cancelled, orderedAt: o.orderedAt, egiftDeliveredAt: o.egiftDeliveredAt, ...(items.length ? { items } : {}) };
  });
}

const STALE_RETURN_DAYS = 14; // as lib/deadlineReminders.ts

// Orders that need a person (lib/orderActions.ts), across every user. Reads only.
export async function actionGroupsFor(now: Date): Promise<ActionGroups> {
  const since = new Date(now.getTime() - ACTION_WINDOW_DAYS * 86400000);
  const staleBefore = new Date(now.getTime() - STALE_RETURN_DAYS * 86400000);
  const links = await prisma.bankMatch.findMany({ where: { kind: { in: ['payout', 'payout_shortfall'] } } });
  const plain = links.map(l => ({ txnId: l.txnId, kind: l.kind, refId: l.refId, amountCents: l.amountCents, note: l.note }));
  const shortfalls = new Map<number, number>();
  for (const d of openDepositShortfalls(plain)) for (const o of d.orders) shortfalls.set(o.orderId, (shortfalls.get(o.orderId) ?? 0) + o.shortCents);
  // "More coming" clears nothing, so it stays on the list until it arrives.
  for (const l of links) if (l.kind === 'payout_shortfall' && l.note === 'shortfall:more') shortfalls.set(l.refId, (shortfalls.get(l.refId) ?? 0) + l.amountCents);
  const rows = await prisma.order.findMany({
    where: { cancelled: false, ignoredByRule: false, blockedAddressPattern: null, OR: [{ orderDate: { gte: since } }, { id: { in: [...shortfalls.keys()] } }] },
    select: {
      id: true, userId: true, orderNumber: true, platform: true, buyerId: true, orderDate: true, cost: true, salePrice: true, salePriceSynced: true,
      bgExpectedPayout: true, bgPaidAmount: true, bgPaidAt: true, bgCredited: true, bfmrStatus: true, buyerMismatch: true, overdueAt: true,
      lost: true, locked: true, cancelled: true, trackingNumbers: true, trackingSubmittedToBg: true, blockedAddressPattern: true,
      belowCostAlert: true, bfmrRejectedItems: true, bfmrReceived: true,
      buyer: { select: { name: true } },
      returns: { where: { status: { in: [...OPEN_RETURN_STATUSES] }, requestedAt: { lt: staleBefore } }, select: { id: true } },
    },
  });
  const byUser = new Map<number | null, typeof rows>();
  for (const r of rows) byUser.set(r.userId, [...(byUser.get(r.userId) ?? []), r]);
  const delivery = new Map<number, ActionDelivery>();
  for (const [uid, list] of byUser) {
    // Only orders that could be flagged for delivery need the carrier lookup.
    const need = list.filter(o => o.trackingNumbers && !o.salePriceSynced && !o.lost);
    const dv = await loadDeliveryVsReceived(uid, need.map(o => ({ id: o.id, trackingNumbers: o.trackingNumbers, orderDate: o.orderDate, bfmrReceived: o.bfmrReceived, bfmrStatus: o.bfmrStatus, buyer: o.buyer }))).catch(() => new Map());
    for (const [id, v] of dv) delivery.set(id, { state: v.delivered.state, daysSinceDelivered: v.daysSinceDelivered, lateReceipt: v.lateReceipt });
  }
  const orders: ActionOrder[] = rows.map(o => ({
    id: o.id, orderNumber: o.orderNumber, platform: o.platform, buyerId: o.buyerId, buyerName: o.buyer?.name ?? null, orderDate: o.orderDate,
    cost: o.cost, salePrice: o.salePrice, salePriceSynced: o.salePriceSynced, bgExpectedPayout: o.bgExpectedPayout, bgPaidAmount: o.bgPaidAmount,
    bgPaidAt: o.bgPaidAt, bgCredited: o.bgCredited, bfmrStatus: o.bfmrStatus, buyerMismatch: o.buyerMismatch, overdueAt: o.overdueAt,
    lost: o.lost, locked: o.locked, cancelled: o.cancelled, trackingNumbers: o.trackingNumbers, trackingSubmittedToBg: o.trackingSubmittedToBg,
    blockedAddressPattern: o.blockedAddressPattern, belowCostAlert: o.belowCostAlert, bfmrRejectedItems: o.bfmrRejectedItems,
    staleOpenReturn: o.returns.length > 0, delivery: delivery.get(o.id) ?? null,
  }));
  return classifyActionOrders(orders, shortfalls, now);
}

export async function countsFor(start: Date, end: Date, now: Date): Promise<DigestCounts> {
  const inDay = { gte: start, lt: end };
  const [byPlatform, addedWithoutCard, syncs, cardsSubmitted, waiting, pastShipBy, unseenErrors] = await Promise.all([
    prisma.order.groupBy({ by: ['platform'], where: { createdAt: inDay, cancelled: false }, _count: { _all: true } }),
    prisma.order.count({ where: { createdAt: inDay, cancelled: false, cardId: null } }),
    prisma.syncEvent.aggregate({ where: { createdAt: inDay }, _count: { _all: true }, _sum: { imported: true, updated: true } }),
    prisma.giftCard.count({ where: { ccSubmittedAt: inDay } }),
    prisma.order.count({ where: waitingToShip }),
    prisma.order.count({ where: { ...waitingToShip, deliveryDeadline: { lt: now } } }),
    prisma.apiError.count({ where: { seen: false } }),
  ]);
  return {
    ordersAdded: Object.fromEntries(byPlatform.map(r => [r.platform, r._count._all])),
    addedWithoutCard,
    syncRuns: syncs._count._all,
    syncOrdersChanged: (syncs._sum.imported ?? 0) + (syncs._sum.updated ?? 0),
    cardsSubmitted,
    waitingToShip: waiting,
    pastShipBy,
    unseenErrors,
  };
}

let running = false;

export async function runDigestLines(now: Date = new Date()): Promise<void> {
  if (!process.env.DIGEST_QUEUE_URL || !process.env.DIGEST_QUEUE_TOKEN || running) return;
  running = true;
  try {
    // The action section is as of now whichever day is posted; a failed query costs it, not the day's counts.
    const actions = await actionGroupsFor(now).catch(e => { console.warn('[digest-lines] action query failed:', String(e).slice(0, 160)); return undefined; });
    for (const back of daysToPost(now)) {
      const { day, start, end } = dayWindow(now, back);
      const counts = await countsFor(start, end, now);
      // A failed reset query costs the reset lines, not the day's counts.
      const orders = await resetOrdersFor(day).catch(e => { console.warn('[digest-lines] reset query failed:', String(e).slice(0, 160)); return null; });
      const { lines, needsYou } = buildDigestLines({ ...counts, ...(orders ? { resets: { day, orders } } : {}), ...(actions ? { actions } : {}) });
      const r = await postDigestLines(day, lines, needsYou);
      if (r.result === 'failed') console.warn(`[digest-lines] ${day} not sent: ${r.status ?? 'no response'} ${r.error ?? ''}`.trim());
      if (r.result === 'skipped') break; // queue lacks the route or its key; try again next tick
    }
  } catch (e) {
    console.error('[digest-lines] tick failed:', e);
  } finally {
    running = false;
  }
}

export function startDigestLines(): void {
  const run = gated('digest-lines', runDigestLines);
  setTimeout(() => { void run(); }, 5 * 60 * 1000);
  setInterval(() => { void run(); }, TICK_MS);
}
