import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { NextRequest } from 'next/server';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const uid = await getSessionUserId();
  if (uid == null) return Response.json({ error: 'not authenticated' }, { status: 401 });

  const body = await req.json() as {
    orderId?: number;
    reservationId?: number;
    trackingNumber?: string | null;
    quantity?: number;
    value?: number | null;
  };

  if (typeof body.orderId !== 'number' || typeof body.reservationId !== 'number') {
    return Response.json({ error: 'orderId and reservationId required' }, { status: 400 });
  }

  const quantity = Math.max(1, Math.floor(body.quantity ?? 1));
  const trackingNumber = body.trackingNumber || null;
  const value = body.value ?? null;

  const [order, reservation] = await Promise.all([
    prisma.order.findFirst({ where: { id: body.orderId, userId: uid }, select: { id: true } }),
    prisma.bfmrReservation.findFirst({ where: { id: body.reservationId, userId: uid }, select: { id: true } }),
  ]);
  if (!order) return Response.json({ error: 'order not found' }, { status: 404 });
  if (!reservation) return Response.json({ error: 'reservation not found' }, { status: 404 });

  try {
    const existing = await prisma.orderBfmrLink.findFirst({
      where: {
        orderId: body.orderId,
        reservationId: body.reservationId,
        trackingNumber,
      },
    });

    let link;
    if (existing) {
      link = await prisma.orderBfmrLink.update({
        where: { id: existing.id },
        data: { quantity, value },
      });
    } else {
      link = await prisma.orderBfmrLink.create({
        data: {
          orderId: body.orderId,
          reservationId: body.reservationId,
          trackingNumber,
          quantity,
          value,
        },
      });
    }
    return Response.json(link);
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
