import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { NextRequest } from 'next/server';

export const dynamic = 'force-dynamic';

// One-shot cleanup: find Walmart orders where trackingNumbers equals the
// order number (digits-only or with dashes) and clear the tracking. These
// rows were created by extension v1.1.43 which always fell back to the
// order number when detail fetch returned no carrier tracking — fixed in
// v1.1.44 but pre-existing rows still need cleanup.
//
// GET: returns the candidate rows (dry-run preview)
// POST: actually clears them
export async function GET(req: NextRequest) {
  const userId = await getUserId(req);
  if (userId == null) return Response.json({ error: 'unauthorized' }, { status: 401 });
  const candidates = await findCandidates(userId);
  return Response.json({ count: candidates.length, candidates });
}

export async function POST(req: NextRequest) {
  const userId = await getUserId(req);
  if (userId == null) return Response.json({ error: 'unauthorized' }, { status: 401 });
  const candidates = await findCandidates(userId);
  if (candidates.length === 0) return Response.json({ cleared: 0 });
  await prisma.order.updateMany({
    where: { id: { in: candidates.map(c => c.id) } },
    data: { trackingNumbers: null },
  });
  return Response.json({ cleared: candidates.length });
}

async function getUserId(req: NextRequest): Promise<number | null> {
  const sessionUid = await getSessionUserId();
  if (sessionUid != null) return sessionUid;
  const headerUid = req.headers.get('X-Extension-User-Id');
  return headerUid ? parseInt(headerUid) : null;
}

async function findCandidates(userId: number) {
  const rows = await prisma.order.findMany({
    where: {
      userId,
      platform: 'Walmart',
      trackingNumbers: { not: null },
      orderNumber: { not: null },
    },
    select: { id: true, orderNumber: true, trackingNumbers: true },
  });
  return rows.filter(r => {
    if (!r.orderNumber || !r.trackingNumbers) return false;
    const ordNoDashes = r.orderNumber.replace(/-/g, '');
    return r.trackingNumbers === ordNoDashes || r.trackingNumbers === r.orderNumber;
  });
}
