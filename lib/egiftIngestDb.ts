import { prisma, getSetting } from '@/lib/db';
import { handlePut } from '@/lib/egiftLinkApi';
import { makeEgiftDeps } from '@/lib/egiftLinkDeps';
import { encryptSetting } from '@/lib/secrets';
import { EGIFT_DEFAULT_EMAIL_KEY, normalizeEgiftEmail } from '@/lib/egiftEmail';
import { egiftScrapeCommand } from '@/lib/egiftScrape';
import { canonicalCommandPayload } from '@/lib/extensionCommandDedupe';
import { withKeyedLock } from '@/lib/keyedLock';
import { decryptSetting } from '@/lib/secrets';
import { ingestEgiftDeliveries, sweepLinkedOrders, countsLine, type IngestDeps, type SweepDeps } from '@/lib/egiftIngest';
import type { EgiftDelivery } from '@/lib/egiftDelivery';

// prisma wiring for lib/egiftIngest.ts. Called after each email fetch (the signed-in Email tab sync
// and the 5-minute auto import). Safe to call on every run: it only acts once per order.

const payloadFor = (orderId: number) => JSON.stringify(canonicalCommandPayload('SCRAPE_EGIFT', { orderId }));

const deps: IngestDeps = {
  findCostcoOrders: (digits) =>
    prisma.order.findMany({
      where: { platform: 'Costco', orderNumber: { contains: digits } },
      select: { id: true, userId: true, orderNumber: true },
    }),
  hasLink: async (orderId) => !!(await prisma.orderEgiftLink.findUnique({ where: { orderId }, select: { id: true } })),
  putLink: async (order, link) => {
    // The same handler the egift-link PUT route runs, acting as the order's owner.
    const res = await handlePut(
      makeEgiftDeps(async () => order.userId),
      new Request('http://localhost/internal/egift-link', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ link }),
      }),
      String(order.id),
    );
    return res.ok;
  },
  hasOrderEmail: async (orderId) => !!(await prisma.orderEgiftEmail.findUnique({ where: { orderId }, select: { id: true } })),
  saveOrderEmail: async (orderId, email) => {
    await prisma.orderEgiftEmail.upsert({
      where: { orderId },
      create: { orderId, emailEnc: encryptSetting(email) },
      update: {},
    });
  },
  hasAnyEmail: async (order) => {
    const own = await prisma.orderEgiftEmail.findUnique({ where: { orderId: order.id }, select: { emailEnc: true } });
    if (own && normalizeEgiftEmail(decryptSetting(own.emailEnc))) return true;
    const def = await getSetting(order.userId, EGIFT_DEFAULT_EMAIL_KEY);
    return normalizeEgiftEmail(def?.value) != null;
  },
  hasCards: async (orderId) => (await prisma.giftCard.count({ where: { orderId } })) > 0,
  hasScrapeCommand: async (orderId) =>
    !!(await prisma.extensionCommand.findFirst({ where: { type: 'SCRAPE_EGIFT', payload: payloadFor(orderId) }, select: { id: true } })),
  queueScrape: async (orderId) => {
    const cmd = egiftScrapeCommand(orderId);
    await prisma.extensionCommand.create({
      data: { type: cmd.type, targetBrowser: cmd.targetBrowser, payload: payloadFor(orderId) },
    });
  },
};

/** Handles every eGift delivery email in a fetched batch. Never throws; logs counts only. */
export async function ingestEgiftEmails(
  emails: readonly { egiftDelivery?: EgiftDelivery }[],
  opts: { userId?: number | null } = {},
): Promise<void> {
  const deliveries = emails.flatMap(e => (e.egiftDelivery ? [e.egiftDelivery] : []));
  if (!deliveries.length) return;
  try {
    // One run at a time, so two overlapping syncs cannot both queue the same order.
    const counts = await withKeyedLock('egift-ingest', () => ingestEgiftDeliveries(deliveries, deps, opts));
    console.log(countsLine(counts));
  } catch {
    console.error('[egift-ingest] run failed');
  }
}

const SWEEP_DAYS = 30;
const sweepDeps: SweepDeps = {
  listLinkedOrders: (userId) =>
    prisma.order.findMany({
      where: {
        platform: 'Costco',
        egiftLink: { isNot: null },
        createdAt: { gte: new Date(Date.now() - SWEEP_DAYS * 24 * 60 * 60 * 1000) },
        ...(userId !== undefined ? { userId } : {}),
      },
      select: { id: true, userId: true, orderNumber: true },
    }),
  hasCards: deps.hasCards,
  hasScrapeCommand: deps.hasScrapeCommand,
  hasAnyEmail: deps.hasAnyEmail,
  queueScrape: deps.queueScrape,
};

/**
 * Queues the scrape for recent orders that have a link but no scrape yet (the address was missing
 * when the link was saved) and returns how many still wait for a recipient email. Never throws.
 */
export async function sweepEgiftScrapes(opts: { userId?: number | null } = {}): Promise<{ queued: number; waiting: number }> {
  try {
    const r = await withKeyedLock('egift-ingest', () => sweepLinkedOrders(sweepDeps, opts));
    if (r.queued || r.waiting || r.failed) console.log(`[egift-sweep] queued=${r.queued} waiting=${r.waiting} failed=${r.failed}`);
    return { queued: r.queued, waiting: r.waiting };
  } catch {
    console.error('[egift-sweep] run failed');
    return { queued: 0, waiting: 0 };
  }
}
