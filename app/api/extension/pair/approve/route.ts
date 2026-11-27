import { getSessionUser } from '@/lib/auth';
import { approvePairing, pairStore, sameOriginRequest } from '@/lib/extensionPairing';

// The approval click on /extension/pair. Needs the tracker session (not the extension secret) and a
// same-origin request, so another site cannot approve a pairing with the user's cookie.
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  if (!sameOriginRequest(req.headers)) return Response.json({ error: 'cross-site request' }, { status: 403 });
  const user = await getSessionUser();
  if (!user) return Response.json({ error: 'sign in first' }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const code = typeof body?.code === 'string' ? body.code : '';
  if (!approvePairing(pairStore(), code, user)) {
    return Response.json({ error: 'this pairing expired or was already approved; press Pair in the extension again' }, { status: 410 });
  }
  return Response.json({ ok: true, userName: user.name });
}
