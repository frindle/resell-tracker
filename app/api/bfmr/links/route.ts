import { prisma, getSetting } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { recalcBfmrSalePrice } from '@/lib/bfmrSalePrice';
import { pushReservationOrderNumber } from '@/lib/bfmrWeb';
import { shouldPushOrderNumber } from '@/lib/bfmrPushGate';
import { NextRequest } from 'next/server';

// Applies to every handler in this file. Without it a GET Route Handler in
// this Next.js version can be evaluated once at build time and serve that
// same response forever -- and the GET below is a per-user live query.
export const dynamic = 'force-dynamic';

// Dry run: return the EXACT tracker_data row a POST would send to BFMR,
// without posting it and without creating a link.
//
//   GET /api/bfmr/links?orderId=890&reservationId=115438&quantity=2
//
// This POSTs order numbers against real reservations on a money path, and a
// wrong push mislabels a real reservation. Being able to read the payload
// first -- with its real types -- is the only safe way to verify a change
// here, so it is a first-class route rather than a temporary console.log.
export async function GET(req: NextRequest) {
  const uid = await getSessionUserId();
  if (uid == null) return Response.json({ error: 'not authenticated' }, { status: 401 });

  const sp = req.nextUrl.searchParams;
  const orderId = parseInt(sp.get('orderId') ?? '', 10);
  const reservationId = parseInt(sp.get('reservationId') ?? '', 10);
  if (!Number.isInteger(orderId) || !Number.isInteger(reservationId)) {
    return Response.json({ error: 'orderId and reservationId query params required' }, { status: 400 });
  }

  const [order, reservation] = await Promise.all([
    prisma.order.findFirst({ where: { id: orderId, userId: uid }, select: { id: true, orderNumber: true } }),
    prisma.bfmrReservation.findFirst({ where: { id: reservationId, userId: uid } }),
  ]);
  if (!order) return Response.json({ error: 'order not found' }, { status: 404 });
  if (!reservation) return Response.json({ error: 'reservation not found' }, { status: 404 });
  if (!order.orderNumber) return Response.json({ error: 'order has no orderNumber' }, { status: 400 });
  if (!reservation.myTrackerId) {
    return Response.json({
      error: 'reservation has no myTrackerId — nothing can be pushed until a sync backfills it',
      reservationId, myTrackerId: null,
    }, { status: 409 });
  }

  const quantity = Math.max(1, Math.floor(parseInt(sp.get('quantity') ?? '', 10) || reservation.qty));

  const [emailRow, passwordRow] = await Promise.all([
    getSetting(uid, 'bfmr_email'),
    getSetting(uid, 'bfmr_password'),
  ]);
  if (!emailRow?.value || !passwordRow?.value) {
    return Response.json({ error: 'BFMR web credentials not configured' }, { status: 400 });
  }

  try {
    const result = await pushReservationOrderNumber(
      emailRow.value, passwordRow.value,
      reservation.myTrackerId, quantity, order.orderNumber, uid, { dryRun: true },
    );
    return Response.json({
      orderId, orderNumber: order.orderNumber, reservationId,
      localQty: reservation.qty,
      ...result,
      // Types are the whole point of the dry run -- a base64 string where a
      // number belongs is exactly the bug this route exists to catch.
      payloadTypes: Object.fromEntries(
        Object.entries(result.payload).map(([k, v]) => [k, v === null ? 'null' : typeof v]),
      ),
    });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 502 });
  }
}

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

    // Push the order number to BFMR. ONE shape covers both cases: BFMR has no
    // split endpoint, and reducing qty on the row while assigning the order
    // number IS the split -- it peels off the assigned units, marks them
    // Purchased, and leaves the remainder as its own reservation awaiting a
    // second order number. Posting the row's current qty just sets the order
    // number. Captured from BFMR's own "Multiple Order No." flow; see
    // lib/bfmrWeb.ts pushReservationOrderNumber.
    //
    // Correction to what a previous comment here claimed: linking 3-to-Amazon
    // did NOT work while 2-to-Walmart failed. Nothing here has ever pushed
    // anything. The guard below also required reservation.myTrackerId, and
    // measured live 2026-08-25 that column is null on 708/708 reservations --
    // so the push was skipped every time, silently, for every link ever made.
    //
    // The push needs exactly ONE thing from our own records: myTrackerId. It
    // used to also require reserveId/dealId/itemId and then parseInt() the
    // base64 ones, which is NaN -> null in the payload. Everything numeric now
    // comes from BFMR's own live row (lib/bfmrWeb.ts pushReservationOrderNumber).
    //
    // Whether to push at all lives in lib/bfmrPushGate.ts, with its cases. It
    // used to be an inline `!existing && ...`, meaning "only the very first
    // time this exact link row is created" -- so link-then-adjust-qty, the
    // normal flow since 389b575 put the qty box on the row, never pushed.
    const gate = shouldPushOrderNumber({
      orderNumber: order.orderNumber,
      myTrackerId: reservation.myTrackerId,
      reservationBfmrOrderId: reservation.bfmrOrderId,
      quantity: link.quantity,
      reservationQty: reservation.qty,
    });
    let bfmrPush: Record<string, unknown> | null = null;
    if (!gate.push) {
      // Loud, not silent: a skipped push is the condition that made this a
      // no-op on 708/708 reservations without ever saying so. Only reported
      // when there was an order number to push in the first place.
      if (order.orderNumber) {
        bfmrPush = { pushed: false, reason: gate.reason };
        console.warn(`[bfmr/links] not pushing order ${order.orderNumber} for reservation ${reservation.id}: ${gate.reason}`);
      }
    } else {
      // The gate only returns push:true once both are present; re-read here so
      // the types follow, rather than asserting non-null.
      const orderNumber = order.orderNumber;
      const myTrackerId = reservation.myTrackerId;
      if (orderNumber && myTrackerId != null) {
        try {
          const [emailRow, passwordRow] = await Promise.all([
            getSetting(uid, 'bfmr_email'),
            getSetting(uid, 'bfmr_password'),
          ]);
          if (!emailRow?.value || !passwordRow?.value) {
            bfmrPush = { pushed: false, reason: 'BFMR web credentials not configured' };
          } else {
            const result = await pushReservationOrderNumber(
              emailRow.value, passwordRow.value,
              myTrackerId, link.quantity, orderNumber, uid,
            );
            bfmrPush = { pushed: true, split: result.split, bfmrQty: result.bfmrQty };
            // After a split BFMR holds two rows where we recorded one, and the
            // remainder's RID is not in the response. Mark this reservation stale
            // so the next sync re-reads both rows; without it the second link
            // would target the pre-split row. `split` comes from BFMR's own
            // current qty, not our possibly-stale local qty.
            await prisma.bfmrReservation.update({
              where: { id: reservation.id },
              data: result.split
                ? { bfmrOrderId: orderNumber, lastSyncedAt: new Date(0) }
                : { bfmrOrderId: orderNumber },
            });
          }
        } catch (e) {
          bfmrPush = { pushed: false, reason: String(e) };
          console.warn('[bfmr/links] failed to push order_id to BFMR:', e);
        }
      }
    }

    return Response.json({ ...link, salePrice, ...(bfmrPush ? { bfmrPush } : {}) });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
