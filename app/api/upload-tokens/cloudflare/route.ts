import { NextRequest } from 'next/server';
import { getSessionUserId } from '@/lib/auth';
import { isOwner } from '@/lib/owner';
import { getUploadCfToken, saveUploadCfToken, clearUploadCfToken, maskClientId } from '@/lib/uploadCfToken';

export const dynamic = 'force-dynamic';

// Status only: never the secret, and only a masked client id.
export async function GET() {
  const uid = await getSessionUserId();
  if (uid == null) return Response.json({ error: 'not authenticated' }, { status: 401 });
  const t = await getUploadCfToken();
  const canEdit = await isOwner(uid);
  return Response.json(t ? { configured: true, source: t.source, clientId: maskClientId(t.clientId), canEdit } : { configured: false, canEdit });
}

// Changing the install-wide token is owner-only.
async function ownerOnly(): Promise<Response | null> {
  const uid = await getSessionUserId();
  if (uid == null) return Response.json({ error: 'not authenticated' }, { status: 401 });
  if (!(await isOwner(uid))) return Response.json({ error: 'only the tracker owner can change the Cloudflare token' }, { status: 403 });
  return null;
}

export async function PUT(req: NextRequest) {
  const denied = await ownerOnly();
  if (denied) return denied;
  const body = await req.json().catch(() => ({})) as { clientId?: string; clientSecret?: string };
  const clientId = (body.clientId ?? '').trim();
  const clientSecret = (body.clientSecret ?? '').trim();
  if (!clientId || !clientSecret) return Response.json({ error: 'both the Client ID and Client Secret are needed' }, { status: 400 });
  if (!clientId.endsWith('.access')) return Response.json({ error: 'the Client ID ends in .access' }, { status: 400 });
  if (/[|\s]/.test(clientId + clientSecret)) return Response.json({ error: 'the token has a space or | in it' }, { status: 400 });
  await saveUploadCfToken(clientId, clientSecret);
  return Response.json({ configured: true, source: 'saved', clientId: maskClientId(clientId), canEdit: true });
}

export async function DELETE() {
  const denied = await ownerOnly();
  if (denied) return denied;
  await clearUploadCfToken();
  const t = await getUploadCfToken();
  return Response.json(t ? { configured: true, source: t.source, clientId: maskClientId(t.clientId), canEdit: true } : { configured: false, canEdit: true });
}
