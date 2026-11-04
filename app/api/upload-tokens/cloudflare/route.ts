import { NextRequest } from 'next/server';
import { getSessionUserId } from '@/lib/auth';
import { getUploadCfToken, saveUploadCfToken, clearUploadCfToken, maskClientId } from '@/lib/uploadCfToken';

export const dynamic = 'force-dynamic';

// Status only: never the secret, and only a masked client id.
export async function GET() {
  if (await getSessionUserId() == null) return Response.json({ error: 'not authenticated' }, { status: 401 });
  const t = await getUploadCfToken();
  return Response.json(t ? { configured: true, source: t.source, clientId: maskClientId(t.clientId) } : { configured: false });
}

export async function PUT(req: NextRequest) {
  if (await getSessionUserId() == null) return Response.json({ error: 'not authenticated' }, { status: 401 });
  const body = await req.json().catch(() => ({})) as { clientId?: string; clientSecret?: string };
  const clientId = (body.clientId ?? '').trim();
  const clientSecret = (body.clientSecret ?? '').trim();
  if (!clientId || !clientSecret) return Response.json({ error: 'both the Client ID and Client Secret are needed' }, { status: 400 });
  if (!clientId.endsWith('.access')) return Response.json({ error: 'the Client ID ends in .access' }, { status: 400 });
  if (/[|\s]/.test(clientId + clientSecret)) return Response.json({ error: 'the token has a space or | in it' }, { status: 400 });
  await saveUploadCfToken(clientId, clientSecret);
  return Response.json({ configured: true, source: 'saved', clientId: maskClientId(clientId) });
}

export async function DELETE() {
  if (await getSessionUserId() == null) return Response.json({ error: 'not authenticated' }, { status: 401 });
  await clearUploadCfToken();
  const t = await getUploadCfToken();
  return Response.json(t ? { configured: true, source: t.source, clientId: maskClientId(t.clientId) } : { configured: false });
}
