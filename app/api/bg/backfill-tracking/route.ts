import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { autoSubmitTrackingForOrders } from '@/lib/autoSubmitTracking';
import { NextRequest } from 'next/server';

// One-shot endpoint to push every eligible BG/BS tracking number that the
// auto-submit pipeline never sent. Useful when the import flow's
// `trackingSubmittedToBg` flag got stuck or older orders predate the
// auto-submit hook. Safe to call repeatedly — the helper itself filters
// to orders where trackingSubmittedToBg=false.
//
// Auth: prefers session cookie (logged-in browser), falls back to the
// X-Extension-User-Id header. When neither is provided, runs across
// every user that has eligible orders (single-user setups need no
// header to curl this from the host).
export async function POST(req: NextRequest) {
  try {
    const sessionUid = await getSessionUserId();
    const headerUid = req.headers.get('X-Extension-User-Id');
    const explicitUid = sessionUid ?? (headerUid ? parseInt(headerUid) : null);

    const buyerFilter = {
      OR: [
        { buyer: { name: { contains: 'buyinggroup' } } },
        { buyer: { name: { contains: 'buying group' } } },
        { buyer: { name: { contains: 'bigsky' } } },
        { buyer: { name: { contains: 'big sky' } } },
      ],
    };

    // Resolve which user IDs to process. Authenticated → that user.
    // Anonymous → every user that has at least one eligible order
    // (lets a host-side curl do the right thing on a single-user box).
    let userIds: (number | null)[];
    if (explicitUid != null) {
      userIds = [explicitUid];
    } else {
      const distinct = await prisma.order.findMany({
        where: { trackingNumbers: { not: null }, trackingSubmittedToBg: false, ...buyerFilter },
        select: { userId: true },
        distinct: ['userId'],
      });
      userIds = distinct.map(d => d.userId);
      if (userIds.length === 0) userIds = [null];
    }

    let total = 0;
    const allOrderIds: number[] = [];
    for (const uid of userIds) {
      const orders = await prisma.order.findMany({
        where: {
          userId: uid,
          trackingNumbers: { not: null },
          trackingSubmittedToBg: false,
          ...buyerFilter,
        },
        select: { id: true },
      });
      console.log(`[bg-backfill] user=${uid}: queued ${orders.length} orders`);
      if (orders.length === 0) continue;
      await autoSubmitTrackingForOrders(uid, orders.map(o => o.id), 'backfill');
      total += orders.length;
      allOrderIds.push(...orders.map(o => o.id));
    }

    return Response.json({ submitted: total, orderIds: allOrderIds });
  } catch (e) {
    console.error('[bg-backfill] error:', e);
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
