import { NextRequest } from 'next/server';
import { getSessionUserId } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { hashUploadToken, newUploadToken } from '@/lib/uploadTokens';
import { getUploadCfToken } from '@/lib/uploadCfToken';

export async function GET() {
  const uid = await getSessionUserId();
  if (uid == null) return Response.json({ error: 'not authenticated' }, { status: 401 });
  const tokens = await prisma.uploadToken.findMany({
    where: { userId: uid, revokedAt: null },
    select: { id: true, name: true, createdAt: true, lastUsedAt: true, _count: { select: { attachments: true } } },
    orderBy: { createdAt: 'desc' },
  });
  return Response.json({ tokens: tokens.map(({ _count, ...t }) => ({ ...t, uploads: _count.attachments })) });
}

// Creates a token and returns it ONCE. Only its hash is stored. The saved
// Cloudflare token rides along (this response only) so the page can put it
// in the setup code.
export async function POST(req: NextRequest) {
  const uid = await getSessionUserId();
  if (uid == null) return Response.json({ error: 'not authenticated' }, { status: 401 });
  const body = await req.json().catch(() => ({})) as { name?: string };
  const name = (body.name ?? '').trim().slice(0, 60) || 'iPhone Shortcut';
  const token = newUploadToken();
  const row = await prisma.uploadToken.create({ data: { userId: uid, name, tokenHash: hashUploadToken(token) } });
  const cf = await getUploadCfToken();
  return Response.json({
    id: row.id, name: row.name, createdAt: row.createdAt, token,
    cf: cf ? { clientId: cf.clientId, clientSecret: cf.clientSecret } : null,
  });
}
