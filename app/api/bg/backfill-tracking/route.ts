import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { autoSubmitTrackingForOrders } from '@/lib/autoSubmitTracking';

// One-shot endpoint to push every eligible BG/BS tracking number that the
// auto-submit pipeline never sent. Useful when the import flow's
// `trackingSubmittedToBg` flag got stuck or older orders predate the
// auto-submit hook. Safe to call repeatedly — the helper itself filters
// to orders where trackingSubmittedToBg=false.
export async function POST() {
  try {
    const userId = await getSessionUserId();

    const orders = await prisma.order.findMany({
      where: {
        userId: userId ?? null,
        trackingNumbers: { not: null },
        trackingSubmittedToBg: false,
        OR: [
          { buyer: { name: { contains: 'buyinggroup' } } },
          { buyer: { name: { contains: 'buying group' } } },
          { buyer: { name: { contains: 'bigsky' } } },
          { buyer: { name: { contains: 'big sky' } } },
        ],
      },
      select: { id: true },
    });

    console.log(`[bg-backfill] queued ${orders.length} orders for submission`);
    if (orders.length === 0) return Response.json({ submitted: 0, orderIds: [] });

    await autoSubmitTrackingForOrders(userId ?? null, orders.map(o => o.id), 'backfill');
    return Response.json({ submitted: orders.length, orderIds: orders.map(o => o.id) });
  } catch (e) {
    console.error('[bg-backfill] error:', e);
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
