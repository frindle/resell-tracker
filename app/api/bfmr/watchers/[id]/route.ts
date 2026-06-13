import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await prisma.bfmrWatcher.delete({ where: { id: parseInt(id) } });
  return new Response(null, { status: 204 });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json() as { active?: boolean };
  const watcher = await prisma.bfmrWatcher.update({
    where: { id: parseInt(id) },
    data: { ...(body.active !== undefined ? { active: body.active } : {}) },
  });
  return Response.json(watcher);
}
