import { prisma, getSetting } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { submitTrackingForReservation, reconcileReservationSubmission, BfmrNotSubmittedError, getWebTrackerRows, WEB_BACKFILL_FETCH } from '@/lib/bfmrWeb';
import { isAlreadyRecorded, submitAndReconcile } from '@/lib/bfmrSubmitFlow';
import { applySubmittedTrackingToLinks } from '@/lib/bfmrAutoLink';
import { BFMR_STATUS_RANK, BFMR_TERMINAL_STATUSES } from '@/lib/bfmr';
import { recalcBfmrSalePrice } from '@/lib/bfmrSalePrice';

// Per-reservation tracking submit driven by the order-detail review UI.
// The UI assembles N rows (each with qty + tracking number) and POSTs
// them here; we validate, then forward to BFMR's POST /api/my-tracker
// with one tracker_data entry per row. submitTrackingForReservation
// fetches BFMR's own numeric tracker-row IDs fresh, matched by this
// reservation's own my_tracker_id (NOT bfmrOrderId — a single order can be
// split across multiple reservations sharing one order_id, so order_id
// alone can't tell them apart; see lib/bfmrWeb.ts for the incident that
// found this).
//
// ACCEPT and VERIFY ARE DECOUPLED (order 111-3026367-4750648: BFMR accepted
// the POST and sent its confirmation email, but a blocking post-submit read-
// back against a lagging BFMR read API hung this route forever — the UI sat
// on "Submitting…" / "0 of 1 already submitted" while the local record was
// never written). The instant BFMR accepts (2xx) we persist the local
// BfmrSubmittedShipment record and return success; the verify read-back runs
// as a NON-BLOCKING reconciliation (bounded, hard-timeout fetches via
// reconcileReservationSubmission) whose only job is to flag a mismatch in
// the log later. It can never hang the UI or revert a recorded submission.
// And once rows are recorded locally, repeating them is an idempotent no-op
// — we answer "already submitted" WITHOUT re-POSTing to BFMR (the exact
// double-upload risk the old hang created).
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
    if (reservation.myTrackerId == null) {
      return Response.json({
        error: 'reservation has no BFMR tracker id yet — sync reservations from BFMR first (needed to target the right tracker row when the order is split across reservations).',
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

    // Idempotency guard (the double-upload risk the old hang created): once
    // these rows are recorded locally, a repeat of them is a NO-OP — answer
    // "already submitted" WITHOUT re-POSTing to BFMR. The UI's own button
    // gate (remainingQty) already hides this case; this is the server-side
    // backstop for retries that race it or bypass it.
    if (isAlreadyRecorded(reservation.submittedShipments, rows)) {
      return Response.json({ alreadySubmitted: true, submitted: 0, totalQty });
    }

    const bfmrOrderId = reservation.bfmrOrderId; // non-null: checked above
    let effectiveMyTrackerId = reservation.myTrackerId;
    let linkActions: Awaited<ReturnType<typeof applySubmittedTrackingToLinks>> = [];

    try {
      // ACCEPT → RECORD → (detached) RECONCILE. The response returns the
      // moment BFMR accepts the POST and the local record is persisted — it
      // never waits on the verify read-back, so a lagging/hanging BFMR read
      // API can no longer leave the UI stuck on "Submitting…" (order
      // 111-3026367-4750648: BFMR sent its confirmation email while our
      // button spun forever). A verify mismatch is flagged in the log, never
      // used to revert a recorded submission.
      await submitAndReconcile({
        postToBfmr: async () => {
          try {
            await submitTrackingForReservation(
              emailRow.value,
              passwordRow.value,
              bfmrOrderId,
              effectiveMyTrackerId,
              rows,
              userId,
            );
          } catch (e) {
            // Handle the specific 409 error case where BFMR tracker row not
            // found: a stale myTrackerId — re-sync reservations and retry once.
            if (!(e instanceof Error && e.message.includes('No BFMR tracker row found for my_tracker_id'))) throw e;
            try {
              const trackerRows = await getWebTrackerRows(emailRow.value, passwordRow.value, userId, WEB_BACKFILL_FETCH);

              // Find the correct myTrackerId from fresh data for this reservation's order_id
              let newMyTrackerId: number | null = null;
              if (bfmrOrderId) {
                const matchingRow = trackerRows.find(row =>
                  row.order_id === bfmrOrderId ||
                  (row.my_tracker_id === reservation.myTrackerId)
                );
                if (matchingRow) {
                  newMyTrackerId = matchingRow.my_tracker_id;
                }
              }

              // If we found a valid myTrackerId, update the reservation and retry.
              // Recording happens ONCE in recordSubmission below, whichever path landed.
              if (newMyTrackerId !== null && newMyTrackerId !== reservation.myTrackerId) {
                effectiveMyTrackerId = newMyTrackerId;
                await prisma.bfmrReservation.update({
                  where: { id: reservationId },
                  data: { myTrackerId: newMyTrackerId }
                });

                // Retry submission with updated tracker ID
                await submitTrackingForReservation(
                  emailRow.value,
                  passwordRow.value,
                  bfmrOrderId,
                  newMyTrackerId,
                  rows,
                  userId,
                );
              } else {
                throw e; // no valid fresh ID — surface the original error
              }
            } catch (retryError) {
              // If the retry fails or we can't find a valid tracker ID, fall through to original error
              console.warn(`[bfmr/submit-reservation-tracking] Retry failed after stale myTrackerId for reservation ${reservationId}:`, retryError);
              throw e;
            }
          }
        },

        recordSubmission: async () => {
          // Record what shipped so the next submit's "remaining qty" reflects it —
          // BFMR's own GET response shape for already-submitted rows isn't
          // captured yet, so this is tracked locally instead. Runs ONLY after
          // accept; its completion is what flips the UI to "1 of 1 submitted".
          await prisma.bfmrSubmittedShipment.createMany({
            data: rows.map(r => ({
              reservationId,
              qty: r.qty,
              trackingNumber: r.trackingNumber,
            })),
          });

          // Full local submission = shipped. The reservation's STATUS BADGE reads
          // reservation.status, which only the sync route writes (and it derives
          // 'shipped' from BFMR's own tracking_number) — so a fully-submitted line
          // whose BFMR tracking landed on a sibling row stayed 'purchased' forever
          // and dragged order.bfmrStatus down with it. Promote it here, guarded by
          // rank: never overwrite a status that already ranks >= shipped (a later
          // sync reporting processed/paid still wins), and never touch terminal
          // statuses (cancelled/returned/etc. are authoritative). Non-fatal — the
          // submit itself has already succeeded at this point, so bookkeeping must
          // not report the whole operation as failed and invite a duplicate re-submit.
          if (alreadySubmittedQty + totalQty >= reservation.qty) {
            const currentRank = BFMR_STATUS_RANK[reservation.status] ?? 0;
            const isTerminal = BFMR_TERMINAL_STATUSES.has(reservation.status.toLowerCase().trim());
            if (!isTerminal && currentRank < (BFMR_STATUS_RANK['shipped'] ?? 0)) {
              try {
                await prisma.bfmrReservation.update({
                  where: { id: reservationId },
                  data: {
                    status: 'shipped',
                    trackingNumber: reservation.trackingNumber ?? rows[rows.length - 1].trackingNumber,
                  },
                });
              } catch (e) {
                console.warn(`[bfmr/submit-reservation-tracking] failed to mark reservation ${reservationId} shipped after full submission:`, e);
              }
            }
          }

          // This submit is the only place that authoritatively knows "these N
          // units + this tracking + this reservation", so it also drives the
          // OrderBfmrLink instead of leaving the link's tracking to a
          // quantity-unaware dropdown in BfmrReservationLinker. Conservative by
          // design — it assigns or splits only when there's exactly one candidate
          // link, and otherwise leaves the links untouched and logs why (see
          // applySubmittedTrackingToLinks).
          //
          // Deliberately after the BFMR push and the shipment rows, and not fatal:
          // the submit itself has already succeeded at this point, so a link
          // bookkeeping failure must not report the whole operation as failed and
          // invite a duplicate re-submit.
          try {
            linkActions = await applySubmittedTrackingToLinks(reservationId, rows);
          } catch (e) {
            console.warn(`[bfmr/submit-reservation-tracking] link reconciliation failed for reservation ${reservationId}:`, e);
          }

          // Roll the linked order(s) up from local statuses. recalcBfmrSalePrice
          // now also promotes order.bfmrStatus to 'shipped' when every sold link's
          // reservation ranks >= shipped — but applySubmittedTrackingToLinks only
          // recalcs orders it actually touched, so a submit that left every link
          // untouched (ambiguous candidates, no links yet) would never promote the
          // order. Recalc is idempotent; safe to run even for already-touched ones.
          const linkedOrders = await prisma.orderBfmrLink.findMany({
            where: { reservationId },
            select: { orderId: true },
          });
          for (const oid of new Set(linkedOrders.map(l => l.orderId))) {
            try {
              await recalcBfmrSalePrice(oid);
            } catch (e) {
              console.warn(`[bfmr/submit-reservation-tracking] order rollup failed for reservation ${reservationId} order ${oid}:`, e);
            }
          }
        },

        reconcile: async () => {
          // Non-blocking verify. Bounded + hard-timeout fetches inside; its
          // ONLY job is to flag a mismatch (order-880 guard) or persistent
          // lag in the log. A slow/hanging BFMR read, or any failure here,
          // must never revert the recorded submission — that's why this runs
          // detached and swallows its own errors.
          try {
            const expected = rows[rows.length - 1].trackingNumber;
            const { verdict, actual } = await reconcileReservationSubmission(
              emailRow.value, passwordRow.value, effectiveMyTrackerId, expected, userId);
            if (verdict !== 'ok') {
              console.error(
                `[bfmr/submit-reservation-tracking] VERIFY ${verdict.toUpperCase()} for reservation ${reservationId}: ` +
                `my_tracker_id=${effectiveMyTrackerId} shows tracking_number=${actual ?? '(empty)'} after accept, ` +
                `not the expected ${expected}. Local record stands — check BFMR's portal.`,
              );
            }
          } catch (e) {
            console.warn(`[bfmr/submit-reservation-tracking] verify could not complete for reservation ${reservationId} (BFMR read slow/unreachable):`, e);
          }
        },
      });

      return Response.json({ submitted: rows.length, totalQty, remainingQty: remainingQty - totalQty, linkActions });
    } catch (e) {
      // A failure before the POST /my-tracker call was ever made (session,
      // tracker-row fetch, or the my_tracker_id match) means BFMR was never
      // asked to record this tracking number — safe to retry, so report it
      // like the other pre-flight 409s above instead of the ambiguous 502
      // that makes the UI warn "may still have reached BFMR".
      if (BfmrNotSubmittedError.is(e)) {
        return Response.json({ error: e.message }, { status: 409 });
      }

      return Response.json({ error: String(e) }, { status: 502 });
    }
  } catch (e) {
    // A failure before the POST /my-tracker call was ever made (session,
    // tracker-row fetch, or the my_tracker_id match) means BFMR was never
    // asked to record this tracking number — safe to retry, so report it
    // like the other pre-flight 409s above instead of the ambiguous 502
    // that makes the UI warn "may still have reached BFMR".
    if (BfmrNotSubmittedError.is(e)) {
      return Response.json({ error: e.message }, { status: 409 });
    }
    return Response.json({ error: String(e) }, { status: 502 });
  }
}
