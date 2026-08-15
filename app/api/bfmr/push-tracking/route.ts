import { prisma, getSetting } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { submitTracking } from '@/lib/bfmrWeb';

export async function POST() {
  const userId = await getSessionUserId();
  const uid = userId ?? null;

  const emailRow = await getSetting(uid, 'bfmr_email');
  const passwordRow = await getSetting(uid, 'bfmr_password');
  if (!emailRow?.value || !passwordRow?.value) {
    return new Response('BFMR credentials not configured', { status: 400 });
  }

  const orders = await prisma.order.findMany({
    where: {
      userId: uid,
      trackingNumbers: { not: null },
      orderNumber: { not: null },
    },
    select: { orderNumber: true, trackingNumbers: true },
  });

  // Build trackingMap: { [orderNumber]: trackingNumber[] }
  // Pass ALL tracking numbers per order so split shipments submit in full
  // when BFMR exposes N rows for the same order_id. submitTracking() pops
  // one tracking per matched row and skips rows that already have one set.
  const trackingMap: Record<string, string[]> = {};
  for (const o of orders) {
    if (!o.orderNumber || !o.trackingNumbers) continue;
    const trackings = o.trackingNumbers.split(',').map(t => t.trim()).filter(Boolean);
    if (trackings.length > 0) trackingMap[o.orderNumber] = trackings;
  }

  if (Object.keys(trackingMap).length === 0) {
    return Response.json({ pushed: 0 });
  }

  try {
    const submitted = await submitTracking(emailRow.value, passwordRow.value, trackingMap, uid);

    // Record what actually went out so the reservation UI (which derives
    // "remaining qty" from BfmrSubmittedShipment, same as the manual
    // per-reservation submit path) reflects it — without this, an
    // automatic push here silently submitted to BFMR but our own DB kept
    // showing "no tracking yet" / "0 of N submitted" forever.
    for (const row of submitted) {
      const reservation = await prisma.bfmrReservation.findFirst({
        where: { userId: uid, bfmrOrderId: row.orderId, myTrackerId: row.myTrackerId },
        select: { id: true },
      });
      if (!reservation) continue; // no local reservation to attribute this row to; BFMR still got it
      await prisma.bfmrSubmittedShipment.create({
        data: { reservationId: reservation.id, qty: row.qty, trackingNumber: row.trackingNumber },
      });
    }

    return Response.json({ pushed: Object.keys(trackingMap).length, submitted: submitted.length });
  } catch (e) {
    return new Response(String(e), { status: 502 });
  }
}
