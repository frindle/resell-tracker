import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { NextRequest } from 'next/server';

export const dynamic = 'force-dynamic';

// DELETE removes an OrderCommitmentLink by id, scoped to the authenticated
// user (verified by joining through the commitment's userId).
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const uid = await getSessionUserId();
  if (uid == null) return Response.json({ error: 'not authenticated' }, { status: 401 });

  const { id } = await params;
  const linkId = parseInt(id);
  if (isNaN(linkId)) return Response.json({ error: 'invalid id' }, { status: 400 });

  const link = await prisma.orderCommitmentLink.findUnique({
    where: { id: linkId },
    include: { commitment: { select: { userId: true } } },
  });
  if (!link || link.commitment.userId !== uid) {
    return Response.json({ error: 'not found' }, { status: 404 });
  }

  await prisma.orderCommitmentLink.delete({ where: { id: linkId } });
  return Response.json({ deleted: true });
}
