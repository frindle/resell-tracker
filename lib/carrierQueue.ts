import { prisma } from '@/lib/db';
import { trackingUserId } from '@/lib/amazonTracking';
import { withKeyedLock } from '@/lib/keyedLock';
import { detectCarrierForOrder } from '@/lib/carrierDetect';
import { CARRIER_STATUS_WORDS } from '@/lib/carrierPage';
import {
  TRACK_CARRIER, CARRIER_EXTENSION_TARGET, CARRIER_ORDER_SCAN_MS, planCarrierChecks, shipDateFor, countQueuedItems,
  type CarrierCandidate, type CarrierCommandPayload,
} from '@/lib/carrierPlan';

// Database side of lib/carrierPlan.ts: loads the group-bound shipments (BG, BFMR, BigSky), asks the planner what is due, and hands
// the extension one TRACK_CARRIER command. checkedAt and attempts are bumped here, when the command is queued,
// so a number is never queued twice while its command is out.

/** A running command older than this is treated as dead. */
const RUNNING_STALE_MS = 30 * 60_000;

/** One stored form per tracking number: no spaces, upper case. */
export const carrierKey = (s: string) => String(s ?? '').trim().replace(/\s+/g, '').toUpperCase();

const locked = <T>(uid: number, work: () => Promise<T>) => withKeyedLock(`carrier_queue:${uid}`, work);

async function inFlight(now: Date): Promise<boolean> {
  const n = await prisma.extensionCommand.count({
    where: {
      type: TRACK_CARRIER,
      OR: [{ status: 'pending' }, { status: 'running', updatedAt: { gte: new Date(now.getTime() - RUNNING_STALE_MS) } }],
    },
  });
  return n > 0;
}

/**
 * Called when the extension polls for commands. Queues up to a few FedEx / UPS lookups for orders bound for a
 * buying group (BuyingGroup, BFMR or BigSky). Returns how many numbers were queued.
 */
export async function materializeCarrierChecks(now = new Date()): Promise<number> {
  const uid = trackingUserId();
  return locked(uid, async () => {
    if (await inFlight(now)) return 0;
    // The planner's 14-day window runs from the shipping email's date (CarrierDelivery.shippedAt) when there is
    // one, else from the order date. So orders are scanned further back than 14 days: an old order can ship late.
    const orderRows = await prisma.order.findMany({
      where: {
        userId: uid, cancelled: false, trackingNumbers: { not: null }, orderDate: { gte: new Date(now.getTime() - CARRIER_ORDER_SCAN_MS) },
        OR: [
          { commitmentLinks: { some: {} } }, { bfmrLinks: { some: {} } }, { bigSkyLinks: { some: {} } },
          // The buyers are named "BuyingGroup" and "BigSkyBuyers"; the spaced forms are kept for older names.
          { buyer: { name: { contains: 'bfmr' } } }, { buyer: { name: { contains: 'buying group' } } }, { buyer: { name: { contains: 'big sky' } } },
          { buyer: { name: { contains: 'buyinggroup' } } }, { buyer: { name: { contains: 'bigsky' } } },
        ],
      },
      select: { id: true, orderDate: true, trackingNumbers: true, platform: true, orderNumber: true },
    });
    if (!orderRows.length) return 0;
    const links = orderRows.map(o => ({ orderId: o.id, order: o }));
    const orderIds = [...new Set(links.map(l => l.orderId))];
    const packages = await prisma.orderPackage.findMany({ where: { orderId: { in: orderIds } }, select: { trackingNumber: true, carrier: true } });
    const nameByNumber = new Map(packages.map(p => [carrierKey(p.trackingNumber), p.carrier]));
    const rows = await prisma.carrierDelivery.findMany({ where: { userId: uid } });
    const shippedByNumber = new Map(rows.map(r => [carrierKey(r.trackingNumber), r.shippedAt]));
    const candidates: CarrierCandidate[] = [];
    for (const l of links) {
      for (const raw of String(l.order.trackingNumbers ?? '').split(',')) {
        const num = carrierKey(raw);
        if (!num) continue;
        candidates.push({
          carrier: detectCarrierForOrder(num, nameByNumber.get(num), l.order),
          trackingNumber: num,
          shippedAt: shipDateFor(shippedByNumber.get(num), l.order.orderDate),
          groupBound: true,
        });
      }
    }
    // Every number handed out in the last day counts toward the daily cap, rechecks too.
    const recent = await prisma.extensionCommand.findMany({
      where: { type: TRACK_CARRIER, createdAt: { gte: new Date(now.getTime() - 24 * 60 * 60_000) } },
      select: { payload: true },
    });
    const sentLast24h = countQueuedItems(recent.map(c => c.payload));
    const items = planCarrierChecks({ candidates, rows, sentLast24h, now });
    if (!items.length) return 0;
    // The command first: if it cannot be created, the numbers keep their try.
    const payload: CarrierCommandPayload = { userId: uid, items, statusWords: CARRIER_STATUS_WORDS };
    await prisma.extensionCommand.create({
      data: { type: TRACK_CARRIER, targetBrowser: CARRIER_EXTENSION_TARGET, payload: JSON.stringify(payload) },
    });
    for (const it of items) {
      await prisma.carrierDelivery.upsert({
        where: { userId_trackingNumber: { userId: uid, trackingNumber: it.trackingNumber } },
        create: { userId: uid, carrier: it.carrier, trackingNumber: it.trackingNumber, source: 'carrier-page', checkedAt: now, attempts: 1 },
        update: { checkedAt: now, attempts: { increment: 1 } },
      });
    }
    console.log(`[carrier-track] queued ${items.length} number(s) user=${uid}`);
    return items.length;
  });
}
