import { prisma } from './db';
import { buildDigestLines, daysToPost, dayWindow, postDigestLines, type DigestCounts } from './digestLines';
import { resetRanges, type ResetItem, type ResetOrder } from './resetLines.ts';
import { gated } from './primaryFlag.ts';

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
    for (const back of daysToPost(now)) {
      const { day, start, end } = dayWindow(now, back);
      const counts = await countsFor(start, end, now);
      // A failed reset query costs the reset lines, not the day's counts.
      const orders = await resetOrdersFor(day).catch(e => { console.warn('[digest-lines] reset query failed:', String(e).slice(0, 160)); return null; });
      const { lines, needsYou } = buildDigestLines(orders ? { ...counts, resets: { day, orders } } : counts);
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
