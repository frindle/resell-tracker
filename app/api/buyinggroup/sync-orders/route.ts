import { getSessionUserId } from '@/lib/auth';
import { runBgReceiptSync } from '@/lib/bgSync';

export async function POST() {
  const userId = await getSessionUserId();
  if (!userId) return new Response('Unauthorized', { status: 401 });

  try {
    await runBgReceiptSync();
    return Response.json({ ok: true });
  } catch (e) {
    return new Response(String(e), { status: 502 });
  }
}
