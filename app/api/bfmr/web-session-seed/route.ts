import { getSessionUserId } from '@/lib/auth';
import { seedBfmrWebSession } from '@/lib/bfmrWeb';

// Manual BFMR web-session seed. BFMR added Google reCAPTCHA v3 to POST /api/login,
// so server-side login() now 403s; this route lets a user paste the token they
// captured from a real browser login (either as {token, xsrf?, cookieStr?} or
// the raw BFMR /api/login response shape — data.user.auth_token is extracted).
export async function POST(req: Request) {
  const userId = await getSessionUserId();
  if (!userId) return new Response('Unauthorized', { status: 401 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new Response('Invalid JSON body', { status: 400 });
  }

  const obj = (body ?? {}) as Record<string, any>;
  // Accept the raw BFMR /api/login response shape too.
  const token: unknown = typeof obj.token === 'string' ? obj.token : obj?.data?.user?.auth_token;
  if (typeof token !== 'string' || !token) {
    return new Response('Missing token', { status: 400 });
  }

  try {
    const { expires } = await seedBfmrWebSession(
      userId,
      token,
      typeof obj.xsrf === 'string' ? obj.xsrf : '',
      typeof obj.cookieStr === 'string' ? obj.cookieStr : '',
    );
    return Response.json({ ok: true, expires });
  } catch (e) {
    return new Response(String(e), { status: 502 });
  }
}
