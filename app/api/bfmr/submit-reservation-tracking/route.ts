import { getSessionUserId } from '@/lib/auth';
import { BfmrNotSubmittedError } from '@/lib/bfmrWeb';
import { RestNotSubmittedError } from '@/lib/bfmrRestFlows';
import { submitReservationTracking } from '@/lib/bfmrSubmitReservation';

// Per-reservation tracking submit driven by the order-detail review UI.
// Thin wrapper: auth + JSON parsing here, everything else (validate, submit to
// BFMR, persist, idempotency, reconcile) lives in lib/bfmrSubmitReservation.ts,
// shared with the guarded auto-submit (lib/bfmrAutoSubmit.ts).
//
// Body: { reservationId: number, rows: [{ qty: number, trackingNumber: string }] }
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

    const result = await submitReservationTracking(userId, body.reservationId, body.rows ?? [], 'manual');
    return Response.json(result.body, { status: result.status });
  } catch (e) {
    if (BfmrNotSubmittedError.is(e) || RestNotSubmittedError.is(e)) {
      return Response.json({ error: e.message }, { status: 409 });
    }
    return Response.json({ error: String(e) }, { status: 502 });
  }
}
