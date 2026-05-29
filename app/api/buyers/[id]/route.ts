import { prisma } from '@/lib/db';
import { NextRequest } from 'next/server';

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await prisma.buyer.delete({ where: { id: parseInt(id) } });
  return new Response(null, { status: 204 });
}
