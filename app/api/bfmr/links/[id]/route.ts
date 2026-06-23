import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { recalcBfmrSalePrice } from '@/lib/bfmrSalePrice';
import { NextRequest } from 'next/server';

export const dynamic = 'force-dynamic';

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const uid = await getSessionUserId();
  if (uid == null) return Response.json({ error: 'not authenticated' }, { status: 401 });

  const { id } = await params;
  const linkId = parseInt(id);
  if (isNaN(linkId)) return Response.json({ error: 'invalid id' }, { status: 400 });

  const link = await prisma.orderBfmrLink.findUnique({
    where: { id: linkId },
    include: { reservation: { select: { userId: true } } },
  });
  if (!link || link.reservation.userId !== uid) {
    return Response.json({ error: 'not found' }, { status: 404 });
  }

  const orderId = link.orderId;
  await prisma.orderBfmrLink.delete({ where: { id: linkId } });
  await recalcBfmrSalePrice(orderId);
  return Response.json({ deleted: true });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const uid = await getSessionUserId();
  if (uid == null) return Response.json({ error: 'not authenticated' }, { status: 401 });

  const { id } = await params;
  const linkId = parseInt(id);
  if (isNaN(linkId)) return Response.json({ error: 'invalid id' }, { status: 400 });

  const link = await prisma.orderBfmrLink.findUnique({
    where: { id: linkId },
    include: { reservation: { select: { userId: true } } },
  });
  if (!link || link.reservation.userId !== uid) {
    return Response.json({ error: 'not found' }, { status: 404 });
  }

  const body = await req.json() as { quantity?: number; value?: number | null; trackingNumber?: string | null };
  const patch: Record<string, unknown> = {};
  if (body.quantity != null) patch.quantity = Math.max(1, Math.floor(body.quantity));
  if (body.value !== undefined) patch.value = body.value;
  if (body.trackingNumber !== undefined) patch.trackingNumber = body.trackingNumber || null;

  const updated = await prisma.orderBfmrLink.update({ where: { id: linkId }, data: patch });
  await recalcBfmrSalePrice(link.orderId);
  return Response.json(updated);
}
