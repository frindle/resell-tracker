import { prisma, getSetting, upsertSetting } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { resolveExtensionUserId } from '@/lib/extensionAuth';
import { NextRequest } from 'next/server';

// Force per-request evaluation -- GET route handlers in this Next.js
// version can otherwise get statically evaluated once (e.g. at build
// time, before any real request/session exists) and serve that same
// cached response forever after. Confirmed live on a sibling route
// (api/sidecar/vnc-passwords) tonight: identical response regardless of
// the actual request. This route resolves per-user via session cookie /
// X-Extension-User-Id header, so a cached response would leak one user's
// settings to every caller.
export const dynamic = 'force-dynamic';

// Same X-Extension-User-Id fallback /api/import already uses for
// unattended callers with no session cookie (the browser extension, and
// now the headless sidecar) — lets it read/write its own status/last-sync
// Setting rows (e.g. amazon_session_status, amazon_sidecar_last_sync)
// without a login flow.
async function resolveUserId(req: NextRequest | Request): Promise<number | null> {
  const sessionUid = await getSessionUserId();
  return resolveExtensionUserId(req, sessionUid);
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
  if ('vnc_password' in body) pushVncPasswordRefresh();
  return new Response(null, { status: 204 });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}

// Best-effort push so a new password takes effect on the sidecar's live
// x11vnc session immediately, instead of waiting on its own fallback poll
// (see sidecar/src/poll.js). Never let a push failure fail the settings
// save itself -- the fallback loop covers that case.
function pushVncPasswordRefresh() {
  const ip = process.env.SIDECAR_PUBLIC_IP || process.env.SIDECAR_IP || '10.0.12.40';
  const secret = process.env.SIDECAR_SHARED_SECRET;
  if (!secret) return;
  fetch(`http://${ip}:6081/refresh-vnc-password`, {
    method: 'POST',
    headers: { 'X-Sidecar-Secret': secret },
  }).catch(e => console.error('[settings] vnc password push failed (sidecar will pick it up on its next fallback poll):', e.message));
}

// Keep getSetting exported for other routes that need it
export { getSetting };
