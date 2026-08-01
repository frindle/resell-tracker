import { clearSessionCookie } from '@/lib/auth';

export async function POST() {
  try {
  const res = new Response(null, { status: 204 });
  res.headers.set('Set-Cookie', clearSessionCookie());
  return res;
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
