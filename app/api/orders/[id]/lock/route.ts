import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { NextRequest } from 'next/server';

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
  const userId = await getSessionUserId();
  const { id } = await params;
  const orderId = parseInt(id);
  const order = await prisma.order.findFirst({
    where: { id: orderId, ...(userId ? { userId } : { userId: null }) },
    select: { id: true },
  });
  if (!order) return Response.json({ error: 'Not found' }, { status: 404 });
  await prisma.order.update({ where: { id: orderId }, data: { locked: true } });
  return Response.json({ locked: true });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
  const userId = await getSessionUserId();
  const { id } = await params;
  const orderId = parseInt(id);
  const order = await prisma.order.findFirst({
    where: { id: orderId, ...(userId ? { userId } : { userId: null }) },
    select: { id: true },
  });
  if (!order) return Response.json({ error: 'Not found' }, { status: 404 });
  await prisma.order.update({ where: { id: orderId }, data: { locked: false } });
  return Response.json({ locked: false });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
