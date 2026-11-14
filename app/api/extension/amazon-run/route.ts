import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { resolveExtensionUserId } from '@/lib/extensionAuth';

export const dynamic = 'force-dynamic';

// The extension reports the summary of a "Sync now" run so it shows up in Sync Status.
export async function POST(req: NextRequest) {
  try {
    const userId = resolveExtensionUserId(req, await getSessionUserId());
    if (userId == null) return Response.json({ error: 'unauthorized' }, { status: 401 });
    const b = await req.json().catch(() => ({})) as Record<string, unknown>;
    const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
    const ev = await prisma.syncEvent.create({
      data: { userId, platform: 'Amazon', scraped: n(b.pages), imported: n(b.created), updated: n(b.updated), skipped: n(b.unchanged) },
    });
    return Response.json({ ok: true, id: ev.id, status: typeof b.status === 'string' ? b.status : null });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
