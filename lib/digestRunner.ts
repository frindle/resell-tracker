import { prisma } from './db';
import { buildDigestLines, daysToPost, dayWindow, postDigestLines, type DigestCounts } from './digestLines';
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
      const { lines, needsYou } = buildDigestLines(await countsFor(start, end, now));
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
