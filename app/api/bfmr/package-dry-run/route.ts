import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { runDryRun } from '@/lib/bfmrDryRun';

export const dynamic = 'force-dynamic';

// DRY RUN ONLY. GET reads the log; POST re-evaluates stored packages and
// appends to the log. Neither talks to BFMR or Amazon.
export async function GET() {
  const userId = await getSessionUserId();
  if (userId == null) return Response.json({ error: 'unauthorized' }, { status: 401 });
  const rows = await prisma.bfmrDryRunLog.findMany({ where: { userId }, orderBy: { id: 'desc' }, take: 500 });
  const packages = await prisma.orderPackage.count({ where: { userId } });
  const entries = rows.map(r => ({
    id: r.id, createdAt: r.createdAt, orderNumber: r.orderNumber, trackingNumber: r.trackingNumber,
    decision: r.decision, reason: r.reason, message: r.message,
    wouldSubmit: JSON.parse(r.wouldSubmit), caveats: JSON.parse(r.caveats),
  }));
  return Response.json({ packages, entries });
}

export async function POST() {
  const userId = await getSessionUserId();
  if (userId == null) return Response.json({ error: 'unauthorized' }, { status: 401 });
  const logged = await runDryRun(userId);
  return Response.json({ ok: true, logged });
}
