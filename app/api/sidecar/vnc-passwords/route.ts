import { prisma } from '@/lib/db';

// GET-only handlers are statically cacheable by default in the App Router
// unless they opt into dynamic rendering -- reading req.headers.get() on
// the raw Request param doesn't reliably trigger that on its own, so
// without this the same response (evaluated once, likely at build time
// with no real header present) gets served for every request regardless
// of the actual X-Sidecar-Secret sent. Confirmed live: correct secret,
// wrong secret, and no header all returned an identical cached 401.
export const dynamic = 'force-dynamic';

// Internal-only: lets the headless sidecar's entrypoint build an x11vnc
// passwdfile from every configured user's `vnc_password` setting, so any
// user who's set one can connect to the shared automation display —
// there's one physical X11/VNC session, not one per user, so this
// authorizes *who can connect*, not per-user session isolation.
// Guarded by a shared secret (not session/X-Extension-User-Id auth —
// the sidecar has no logged-in user of its own).
export async function GET(req: Request) {
  const secret = process.env.SIDECAR_SHARED_SECRET;
  if (!secret) return Response.json({ error: 'SIDECAR_SHARED_SECRET not configured' }, { status: 500 });
  if (req.headers.get('X-Sidecar-Secret') !== secret) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  const rows = await prisma.setting.findMany({ where: { key: 'vnc_password' } });
  const passwords = rows.map(r => r.value).filter(v => v.length >= 6);
  return Response.json({ passwords });
}
