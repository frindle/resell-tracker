import { NextRequest } from 'next/server';
import { prisma, getSetting, upsertSetting } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { APPLY_SETTING } from '@/lib/amazonCaptureServer';

export const dynamic = 'force-dynamic';

const csvCell = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;

// Session-authenticated (web UI). GET ?format=csv|json exports; PUT {apply:boolean} flips apply mode.
export async function GET(req: NextRequest) {
  const userId = await getSessionUserId();
  if (userId == null) return Response.json({ error: 'unauthorized' }, { status: 401 });
  const rows = await prisma.amazonCaptureLog.findMany({ where: { userId }, orderBy: { id: 'desc' }, take: 2000 });
  const apply = (await getSetting(userId, APPLY_SETTING))?.value === 'true';
  const format = req.nextUrl.searchParams.get('format');
  if (format === 'csv') {
    const lines = ['time,page,order,action,applied,changes,discrepancies', ...rows.map(r =>
      [r.createdAt.toISOString(), r.pageKind, r.orderNumber, r.action, r.applied, r.changes, r.discrepancies].map(csvCell).join(','))];
    return new Response(lines.join('\n'), { headers: { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="amazon-capture-log.csv"' } });
  }
  const entries = rows.map(r => ({ ...r, changes: JSON.parse(r.changes), discrepancies: JSON.parse(r.discrepancies) }));
  if (format === 'json') return new Response(JSON.stringify(entries, null, 1), { headers: { 'content-type': 'application/json', 'content-disposition': 'attachment; filename="amazon-capture-log.json"' } });
  return Response.json({ apply, entries });
}

export async function PUT(req: NextRequest) {
  const userId = await getSessionUserId();
  if (userId == null) return Response.json({ error: 'unauthorized' }, { status: 401 });
  const b = await req.json().catch(() => ({})) as { apply?: unknown };
  if (typeof b.apply !== 'boolean') return Response.json({ error: 'apply must be boolean' }, { status: 400 });
  await upsertSetting(userId, APPLY_SETTING, b.apply ? 'true' : 'false');
  return Response.json({ ok: true, apply: b.apply });
}
