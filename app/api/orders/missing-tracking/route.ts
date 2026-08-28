import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { resolveExtensionUserId } from '@/lib/extensionAuth';
import { NextRequest } from 'next/server';

// Called by the sidecar right after a full platform sync (poll.js's
// handleCommand, SYNC_AMAZON branch only -- the only platform with a
// targeted per-order resync type, SYNC_AMAZON_ORDER) to find orders that
// still have no tracking number after that sync, so it can dispatch one
// follow-up SYNC_AMAZON_ORDER for exactly those instead of waiting for
// the next windowed sweep to maybe reach them.
//
// Bounded to the last MAX_AGE_DAYS by order date so this doesn't keep
// re-scraping an order that's genuinely never going to get tracking
// (cancelled outside this app's own cancel flow, lost in transit,
// abandoned) forever -- matches AMAZON_COLD_START_DAYS in
// sidecar/src/syncWindow.js, the same boundary the regular sync already
// uses for "how far back is this app's business".
const MAX_AGE_DAYS = 60;

export async function GET(req: NextRequest) {
  try {
    const sessionUid = await getSessionUserId();
    const userId = resolveExtensionUserId(req, sessionUid);
    if (userId == null) return Response.json({ error: 'unauthorized' }, { status: 401 });

    const platform = req.nextUrl.searchParams.get('platform') || 'Amazon';
    const since = new Date(Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000);

    const rows = await prisma.order.findMany({
      where: {
        userId,
        platform,
        cancelled: false,
        lost: false,
        orderDate: { gte: since },
        orderNumber: { not: null },
        OR: [{ trackingNumbers: null }, { trackingNumbers: '' }],
      },
      select: { orderNumber: true },
    });

    const orderNumbers = [...new Set(rows.map(r => r.orderNumber).filter((n): n is string => !!n))];
    return Response.json({ orderNumbers });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
