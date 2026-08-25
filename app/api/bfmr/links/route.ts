import { prisma, getSetting } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { recalcBfmrSalePrice } from '@/lib/bfmrSalePrice';
import { setReservationOrderId, splitReservationWithOrderId } from '@/lib/bfmrWeb';
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
    const salePrice = await recalcBfmrSalePrice(body.orderId);

    // Push the order number to BFMR. Two shapes, decided by whether this link
    // covers the whole reservation or only part of it.
    //
    // PARTIAL is the case that was broken. BFMR combines separate purchases
    // into one reservation -- a qty-5 Apple Pencil covering 3 at Amazon and 2
    // at Walmart -- and the only way to tell BFMR about that is to reduce qty
    // on the row while assigning the order number. That reduction IS the split:
    // BFMR peels off the assigned units, marks them Purchased, and leaves the
    // remainder as its own reservation awaiting a second order number.
    // Captured from BFMR's own "Multiple Order No." flow, see
    // lib/bfmrWeb.ts splitReservationWithOrderId.
    //
    // The `!reservation.bfmrOrderId` guard is deliberately NOT applied to the
    // partial case. It exists to stop re-pushing the same order number, but on
    // a split reservation the second link is a DIFFERENT order number against a
    // DIFFERENT remainder, and the old guard silently skipped it -- which is why
    // linking 3-to-Amazon worked and 2-to-Walmart never reached BFMR.
    const isPartial = reservation.qty != null && quantity < reservation.qty;
    if (!existing && order.orderNumber
        && (isPartial || !reservation.bfmrOrderId)
        && reservation.reserveId && reservation.myTrackerId
        && reservation.dealId && reservation.itemId) {
      try {
        const [emailRow, passwordRow] = await Promise.all([
          getSetting(uid, 'bfmr_email'),
          getSetting(uid, 'bfmr_password'),
        ]);
        if (emailRow?.value && passwordRow?.value) {
          const resInput = {
              reserveId: parseInt(reservation.reserveId, 10),
              purchaseId: reservation.purchaseId ? parseInt(reservation.purchaseId, 10) : null,
              myTrackerId: reservation.myTrackerId,
              dealId: reservation.dealId,
              itemId: reservation.itemId,
              qty: link.quantity,
              status: reservation.status,
              trackingNumber: link.trackingNumber ?? reservation.trackingNumber,
          };
          if (isPartial) {
            await splitReservationWithOrderId(
              emailRow.value, passwordRow.value,
              { ...resInput, retailPrice: reservation.retailPrice ?? null },
              link.quantity, order.orderNumber, uid,
            );
          } else {
            await setReservationOrderId(
              emailRow.value, passwordRow.value, resInput, order.orderNumber, uid,
            );
          }
          // After a split BFMR holds two rows where we recorded one, and the
          // remainder's RID is not in the response. Mark this reservation stale
          // so the next sync re-reads both rows; without it the second link
          // would target the pre-split RID.
          await prisma.bfmrReservation.update({
            where: { id: reservation.id },
            data: isPartial
              ? { bfmrOrderId: order.orderNumber, lastSyncedAt: new Date(0) }
              : { bfmrOrderId: order.orderNumber },
          });
        }
      } catch (e) {
        console.warn('[bfmr/links] failed to push order_id to BFMR:', e);
      }
    }

    return Response.json({ ...link, salePrice });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
