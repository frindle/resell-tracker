import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { resolveExtensionUserId } from '@/lib/extensionAuth';
import { MISSING_TRACKING_SELECT, missingTrackingWhere, selectBackfillOrderNumbers } from '@/lib/missingTrackingBackfill';
import { NextRequest } from 'next/server';

// Called by the sidecar right after a full platform sync (poll.js's
// handleCommand, SYNC_AMAZON branch only -- the only platform with a
// targeted per-order resync type, SYNC_AMAZON_ORDER) to find orders that
// still have no tracking number after that sync, so it can dispatch one
// follow-up SYNC_AMAZON_ORDER for exactly those instead of waiting for
// the next windowed sweep to maybe reach them.
//
// Bounded to the last 60 days by order date so this doesn't keep
// re-scraping an order that's genuinely never going to get tracking
// (cancelled outside this app's own cancel flow, lost in transit,
// abandoned) forever -- matches AMAZON_COLD_START_DAYS in
// sidecar/src/syncWindow.js, the same boundary the regular sync already
// uses for "how far back is this app's business".
//
// Only returns Amazon-shaped order numbers (physical 3-7-7 or digital D01-7-7).
// Skips orders already processed (bgCredited or processed BFMR status) or
// paid in full (salePriceSynced or bgPaidAmount >= expected - 0.01).
const BACKFILL_PLATFORM = 'Amazon';

export async function GET(req: NextRequest) {
  try {
    const sessionUid = await getSessionUserId();
    const userId = resolveExtensionUserId(req, sessionUid);
    if (userId == null) return Response.json({ error: 'unauthorized' }, { status: 401 });

    const platform = req.nextUrl.searchParams.get('platform') || BACKFILL_PLATFORM;
    if (platform !== BACKFILL_PLATFORM) return Response.json({ orderNumbers: [] });

    const rows = await prisma.order.findMany({
      where: missingTrackingWhere(userId),
      select: MISSING_TRACKING_SELECT,
    });

    const orderNumbers = selectBackfillOrderNumbers(rows);
    return Response.json({ orderNumbers });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
