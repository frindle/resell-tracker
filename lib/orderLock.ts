import { prisma } from './db';

export async function requireOrderUnlocked(orderId: number, userId: number | null): Promise<Response | null> {
  const order = await prisma.order.findFirst({
    where: { id: orderId, ...(userId ? { userId } : { userId: null }) },
    select: { locked: true },
  });
  if (!order) return Response.json({ error: 'Not found' }, { status: 404 });
  if (order.locked) return Response.json({ error: 'Order is locked' }, { status: 409 });
  return null;
}
