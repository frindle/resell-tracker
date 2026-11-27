import { pairBrowser, pairStore, startPairing } from '@/lib/extensionPairing';

// Open on purpose (proxy.ts lets it through without the extension secret): the extension calls it
// before it has one. It only creates a pending pairing; nothing is granted until a signed-in user
// approves it on /extension/pair.
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const started = startPairing(pairStore(), pairBrowser(body?.browser));
  if (!started) return Response.json({ error: 'too many pairings waiting; try again in a few minutes' }, { status: 429 });
  return Response.json({ ...started, approveUrl: `/extension/pair?code=${started.code}` }, { headers: { 'Cache-Control': 'no-store' } });
}
