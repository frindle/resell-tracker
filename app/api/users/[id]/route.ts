import { prisma } from '@/lib/db';
import { NextRequest } from 'next/server';

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json();
  if (!body.name?.trim()) return new Response(null, { status: 204 });
  await prisma.user.update({ where: { id: parseInt(id) }, data: { name: body.name.trim() } });
  return new Response(null, { status: 204 });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await prisma.user.delete({ where: { id: parseInt(id) } });
  return new Response(null, { status: 204 });
}
