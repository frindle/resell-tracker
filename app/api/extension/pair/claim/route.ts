import { claimPairing, pairStore } from '@/lib/extensionPairing';

// Open like /api/extension/pair: the code + claim pair is the credential. Once a signed-in user has
// approved, this hands the extension the shared secret and its user id, one time only.
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const code = typeof body?.code === 'string' ? body.code : '';
  const claim = typeof body?.claim === 'string' ? body.claim : '';
  const r = claimPairing(pairStore(), code, claim);
  if (r.status === 'unknown') return Response.json({ status: 'unknown' }, { status: 404, headers: NO_STORE });
  if (r.status === 'pending') return Response.json(r, { headers: NO_STORE });
  // Empty when the tracker has no shared secret set (LAN-trust mode): the extension then needs none.
  const secret = process.env.EXTENSION_SHARED_SECRET ?? '';
  return Response.json({ ...r, secret }, { headers: NO_STORE });
}
