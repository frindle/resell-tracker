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
// Auth: session cookie (logged-in browser) or X-Extension-User-Id header.
// Anonymous callers are refused — previously this endpoint would fan out
// across every user with eligible orders, which let anything on the LAN
// trigger BG submissions for every account on the box.
export async function POST(req: NextRequest) {
  try {
    const sessionUid = await getSessionUserId();
    const headerUid = req.headers.get('X-Extension-User-Id');
    const parsedHeader = headerUid ? parseInt(headerUid) : NaN;
    const explicitUid = sessionUid ?? (Number.isFinite(parsedHeader) ? parsedHeader : null);

    if (explicitUid == null) {
      return Response.json(
        { error: 'authentication required (session cookie or X-Extension-User-Id)' },
        { status: 401 },
      );
    }

    const buyerFilter = {
      OR: [
        { buyer: { name: { contains: 'buyinggroup' } } },
        { buyer: { name: { contains: 'buying group' } } },
        { buyer: { name: { contains: 'bigsky' } } },
        { buyer: { name: { contains: 'big sky' } } },
      ],
    };

    const userIds: (number | null)[] = [explicitUid];

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
