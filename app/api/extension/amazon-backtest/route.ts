import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { buildReport, MAX_REPORT_DAYS, MIN_CHECKED, MIN_MATCH_PERCENT } from '@/lib/amazonBacktest';

export const dynamic = 'force-dynamic';

// Session-authenticated (web UI), like amazon-log. GET ?days=N (1..30, default 30):
// per-field accuracy of captured pages against what the tracker stored, the
// mismatch list, and a verdict. Reads only the summary column, never the HTML.
export async function GET(req: NextRequest) {
  const userId = await getSessionUserId();
  if (userId == null) return Response.json({ error: 'unauthorized' }, { status: 401 });
  const raw = Number(req.nextUrl.searchParams.get('days') ?? MAX_REPORT_DAYS);
  const days = Number.isFinite(raw) ? Math.min(MAX_REPORT_DAYS, Math.max(1, Math.floor(raw))) : MAX_REPORT_DAYS;
  const since = new Date(Date.now() - days * 86400000);
  const rows = await prisma.amazonCapturePage.findMany({
    where: { userId, createdAt: { gte: since } },
    select: { createdAt: true, summary: true },
    orderBy: { createdAt: 'asc' },
  });
  const report = buildReport(rows);
  return Response.json({ days, since: since.toISOString(), minChecked: MIN_CHECKED, minMatchPercent: MIN_MATCH_PERCENT, ...report });
}
