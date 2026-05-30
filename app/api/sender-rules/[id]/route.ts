import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { NextRequest } from 'next/server';

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const userId = await getSessionUserId();
  if (!userId) return new Response('Unauthorized', { status: 401 });

  const { id } = await params;
  await prisma.senderRule.deleteMany({ where: { id: parseInt(id), userId } });
  return new Response(null, { status: 204 });
}
