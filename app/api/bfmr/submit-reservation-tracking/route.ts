import { prisma, getSetting } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { submitTrackingForReservation } from '@/lib/bfmrWeb';

// Per-reservation tracking submit driven by the order-detail review UI.
// The UI assembles N rows (each with qty + tracking number) and POSTs
// them here; we validate, then forward to BFMR's POST /api/my-tracker
// with one tracker_data entry per row. submitTrackingForReservation
// fetches BFMR's own numeric tracker-row IDs fresh (matched by
// bfmrOrderId) rather than trusting this reservation's stored
// purchaseId/myTrackerId/dealId/itemId, which live in a different,
// encrypted-string ID space — see lib/bfmrWeb.ts for why.
//
// Body: { reservationId: number, rows: [{ qty: number, trackingNumber: string }] }
//
// Allocation rule (partial submits ALLOWED): sum(rows.qty) must be ≥1
// and ≤ reservation.qty. We don't yet track "already submitted" qty
// — that requires the partial-submit GET capture, after which we'll
// derive remaining qty from BFMR's response shape.
export async function POST(req: Request) {
  try {
    const userId = await getSessionUserId();
    if (userId == null) return Response.json({ error: 'not authenticated' }, { status: 401 });

    let body: { reservationId?: number; rows?: { qty?: number; trackingNumber?: string }[] };
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: 'invalid json' }, { status: 400 });
    }

    const reservationId = body.reservationId;
    const rows = (body.rows ?? []).map(r => ({
      qty: Number(r.qty),
      trackingNumber: String(r.trackingNumber ?? '').trim(),
    }));

    if (!reservationId || !Number.isInteger(reservationId)) {
      return Response.json({ error: 'reservationId required' }, { status: 400 });
    }
    if (rows.length === 0) {
      return Response.json({ error: 'at least one row required' }, { status: 400 });
    }
    for (const r of rows) {
      if (!Number.isInteger(r.qty) || r.qty < 1) {
        return Response.json({ error: 'every row must have qty ≥ 1' }, { status: 400 });
      }
      if (!r.trackingNumber || r.trackingNumber.length < 8) {
        return Response.json({ error: 'every row must have a tracking number' }, { status: 400 });
      }
    }

    const reservation = await prisma.bfmrReservation.findFirst({
      where: { id: reservationId, userId },
      include: { submittedShipments: true },
    });
    if (!reservation) return Response.json({ error: 'reservation not found' }, { status: 404 });

    if (!reservation.bfmrOrderId) {
      return Response.json({
        error: 'reservation has no order number yet — link it to an order (or sync from BFMR) first.',
      }, { status: 409 });
    }

    const alreadySubmittedQty = reservation.submittedShipments.reduce((s, r) => s + r.qty, 0);
    const remainingQty = reservation.qty - alreadySubmittedQty;
    const totalQty = rows.reduce((s, r) => s + r.qty, 0);
    if (totalQty > remainingQty) {
      return Response.json({
        error: `total qty ${totalQty} exceeds remaining qty ${remainingQty} (${alreadySubmittedQty} of ${reservation.qty} already submitted)`,
      }, { status: 400 });
    }

    const emailRow = await getSetting(userId, 'bfmr_email');
    const passwordRow = await getSetting(userId, 'bfmr_password');
    if (!emailRow?.value || !passwordRow?.value) {
      return Response.json({ error: 'BFMR credentials not configured' }, { status: 400 });
    }

    await submitTrackingForReservation(
      emailRow.value,
      passwordRow.value,
      reservation.bfmrOrderId,
      rows,
      userId,
    );
    // Record what shipped so the next submit's "remaining qty" reflects it —
    // BFMR's own GET response shape for already-submitted rows isn't
    // captured yet, so this is tracked locally instead.
    await prisma.bfmrSubmittedShipment.createMany({
      data: rows.map(r => ({
        reservationId,
        qty: r.qty,
        trackingNumber: r.trackingNumber,
      })),
    });
    return Response.json({ submitted: rows.length, totalQty, remainingQty: remainingQty - totalQty });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 502 });
  }
}
