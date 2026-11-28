import { getSessionUserId } from '@/lib/auth';
import { bgSessionStatus, seedBgSession } from '@/lib/bgAuth';
import { BgAuthError, pastedRefreshToken } from '@/lib/bgAuthTokens';

// The BuyingGroup session (lib/bgAuthTokens.ts). GET: whether there is one and until when. POST {refresh}: store
// a refresh token copied from a logged-in buyinggroup.com tab, for when the session ran out, since the password
// login now needs a CAPTCHA. The token is checked with BuyingGroup before it is kept, and never sent back.

export async function GET() {
  const userId = await getSessionUserId();
  if (!userId) return new Response('Unauthorized', { status: 401 });
  return Response.json(await bgSessionStatus(userId));
}

export async function POST(req: Request) {
  const userId = await getSessionUserId();
  if (!userId) return new Response('Unauthorized', { status: 401 });
  const body = (await req.json().catch(() => null)) as { refresh?: unknown } | null;
  const refresh = pastedRefreshToken(body?.refresh);
  if (!refresh) return new Response('That does not look like a BuyingGroup session token', { status: 400 });
  try {
    const { refreshExpiresAt } = await seedBgSession(userId, refresh);
    return Response.json({ ok: true, refreshExpiresAt });
  } catch (e) {
    if (e instanceof BgAuthError) {
      return new Response(`BuyingGroup refused it (${e.status ?? 'no status'}): ${e.reason}`, { status: 400 });
    }
    return new Response(String(e).slice(0, 300), { status: 502 });
  }
}
