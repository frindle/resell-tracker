import { prisma, getSetting } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { recalcBfmrSalePrice } from '@/lib/bfmrSalePrice';
import { setReservationOrderId } from '@/lib/bfmrWeb';
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
    prisma.order.findFirst({ where: { id: body.orderId, userId: uid }, select: { id: true, orderNumber: true } }),
    prisma.bfmrReservation.findFirst({ where: { id: body.reservationId, userId: uid } }),
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
    await recalcBfmrSalePrice(body.orderId);

    // Push the order number to BFMR so its "Order No." column matches.
    // Only on NEW links (skip updates — already pushed), and only when
    // we have everything needed: order number, BFMR IDs, and the
    // reservation doesn't already carry this order number on BFMR.
    if (!existing && order.orderNumber && !reservation.bfmrOrderId
        && reservation.reserveId && reservation.myTrackerId
        && reservation.dealId && reservation.itemId) {
      try {
        const [emailRow, passwordRow] = await Promise.all([
          getSetting(uid, 'bfmr_email'),
          getSetting(uid, 'bfmr_password'),
        ]);
        if (emailRow?.value && passwordRow?.value) {
          await setReservationOrderId(
            emailRow.value,
            passwordRow.value,
            {
              reserveId: parseInt(reservation.reserveId, 10),
              purchaseId: reservation.purchaseId ? parseInt(reservation.purchaseId, 10) : null,
              myTrackerId: reservation.myTrackerId,
              dealId: reservation.dealId,
              itemId: reservation.itemId,
              qty: reservation.qty,
              status: reservation.status,
              trackingNumber: reservation.trackingNumber,
            },
            order.orderNumber,
            uid,
          );
          // Mirror locally so a re-sync doesn't try to push again
          await prisma.bfmrReservation.update({
            where: { id: reservation.id },
            data: { bfmrOrderId: order.orderNumber },
          });
        }
      } catch (e) {
        // Don't fail the link creation just because the BFMR push failed —
        // the user can retry via "Sync from BFMR" or by relinking.
        console.warn('[bfmr/links] failed to push order_id to BFMR:', e);
      }
    }

    return Response.json(link);
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
