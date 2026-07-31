import { prisma, getSetting, upsertSetting } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { NextRequest } from 'next/server';

// Same X-Extension-User-Id fallback /api/import already uses for
// unattended callers with no session cookie (the browser extension, and
// now the headless sidecar) — lets it read/write its own status/last-sync
// Setting rows (e.g. amazon_session_status, amazon_sidecar_last_sync)
// without a login flow.
async function resolveUserId(req: NextRequest | Request): Promise<number | null> {
  const sessionUid = await getSessionUserId();
  if (sessionUid != null) return sessionUid;
  const headerUid = req.headers.get('X-Extension-User-Id');
  return headerUid ? parseInt(headerUid, 10) : null;
}

export async function GET(req: NextRequest) {
  try {
  const uid = await resolveUserId(req);
  const rows = await prisma.setting.findMany({ where: { userId: uid } });
  const settings: Record<string, string> = {};
  rows.forEach(r => { settings[r.key] = r.value; });
  return Response.json(settings);
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
  const uid = await resolveUserId(req);
  const body: Record<string, string> = await req.json();
  await Promise.all(
    Object.entries(body).map(([key, value]) => upsertSetting(uid, key, value))
  );
  return new Response(null, { status: 204 });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}

// Keep getSetting exported for other routes that need it
export { getSetting };
