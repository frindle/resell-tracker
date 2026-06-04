import { getSessionUserId } from '@/lib/auth';
import { runBgReceiptSync } from '@/lib/bgSync';
import { NextRequest } from 'next/server';

export async function POST(req: NextRequest) {
  const userId = await getSessionUserId();
  if (!userId) return new Response('Unauthorized', { status: 401 });

  let force = false;
  try {
    const body = await req.json();
    force = body.force === true;
  } catch { /* no body */ }

  try {
    const stats = await runBgReceiptSync(force);
    return Response.json({ ok: true, ...stats });
  } catch (e) {
    return new Response(String(e), { status: 502 });
  }
}
