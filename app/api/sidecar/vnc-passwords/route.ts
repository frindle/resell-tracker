import { prisma } from '@/lib/db';

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
