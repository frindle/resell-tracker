import { prisma } from '@/lib/db';
import { trackingUserId } from '@/lib/amazonTracking';
import { withKeyedLock } from '@/lib/keyedLock';
import { commandTarget } from '@/lib/commandWorker';
import {
  DELIVERY_RECHECK_PURPOSE, RECHECK_WINDOW_MS, RECHECK_EVERY_MS, planWalmartRechecks, recheckOrdersOf,
} from '@/lib/walmartDeliveryRecheck';

// Database side of lib/walmartDeliveryRecheck.ts. Called when the sidecar polls for commands. The commands
// themselves are the record of what was re-read and when, so there is no other state.

const TYPE = 'SYNC_WALMART_ORDER';
const RUNNING_STALE_MS = 30 * 60_000;
const key = (s: string) => String(s ?? '').trim().replace(/\s+/g, '').toUpperCase();

/** Queues one re-read of recent Walmart orders with no delivered date, when one is due. Returns how many orders. */
export async function materializeWalmartDeliveryRechecks(now = new Date()): Promise<number> {
  const uid = trackingUserId();
  return withKeyedLock(`walmart_delivery_recheck:${uid}`, async () => {
    // One Walmart page read at a time: wait while any per-order read is waiting or running.
    const busy = await prisma.extensionCommand.count({
      where: { type: TYPE, OR: [{ status: 'pending' }, { status: 'running', updatedAt: { gte: new Date(now.getTime() - RUNNING_STALE_MS) } }] },
    });
    if (busy) return 0;
    const past = await prisma.extensionCommand.findMany({
      where: { type: TYPE, createdAt: { gte: new Date(now.getTime() - RECHECK_WINDOW_MS) } },
      select: { createdAt: true, payload: true },
    });
    const history = past.map(c => ({ createdAt: c.createdAt, orderNumbers: recheckOrdersOf(c.payload) })).filter(h => h.orderNumbers.length);
    if (history.some(h => now.getTime() - h.createdAt.getTime() < RECHECK_EVERY_MS)) return 0;
    const orders = await prisma.order.findMany({
      where: {
        userId: uid, platform: 'Walmart', cancelled: false, locked: false, trackingNumbers: { not: null },
        orderDate: { gte: new Date(now.getTime() - RECHECK_WINDOW_MS) },
      },
      select: { orderNumber: true, orderDate: true, trackingNumbers: true },
    });
    if (!orders.length) return 0;
    const delivered = await prisma.carrierDelivery.findMany({
      where: { userId: uid, status: 'delivered', deliveredAt: { not: null } },
      select: { trackingNumber: true },
    });
    const picked = planWalmartRechecks({
      orders: orders.map(o => ({ orderNumber: String(o.orderNumber ?? ''), orderDate: o.orderDate, trackingNumbers: o.trackingNumbers })),
      deliveredNumbers: new Set(delivered.map(d => key(d.trackingNumber))),
      history,
      now,
    });
    if (!picked.length) return 0;
    await prisma.extensionCommand.create({
      data: { type: TYPE, targetBrowser: commandTarget(TYPE), payload: JSON.stringify({ orderNumbers: picked, userId: uid, purpose: DELIVERY_RECHECK_PURPOSE }) },
    });
    console.log(`[walmart-delivery] queued ${picked.length} order re-read(s) user=${uid}`);
    return picked.length;
  });
}
