import { NextRequest } from 'next/server';
import { getSessionUserId } from '@/lib/auth';
import { prisma } from '@/lib/db';

// Revokes a token (kept as a revoked row, not deleted).
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const uid = await getSessionUserId();
  if (uid == null) return Response.json({ error: 'not authenticated' }, { status: 401 });
  const { id } = await params;
  const { count } = await prisma.uploadToken.updateMany({
    where: { id: parseInt(id, 10), userId: uid, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return count ? new Response(null, { status: 204 }) : new Response('Not found', { status: 404 });
}
