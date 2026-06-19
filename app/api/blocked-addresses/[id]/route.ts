import { prisma } from '@/lib/db';
import { NextRequest } from 'next/server';

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
  const { id } = await params;
  await prisma.blockedAddress.delete({ where: { id: parseInt(id) } });
  return new Response(null, { status: 204 });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
