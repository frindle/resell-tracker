// BFMR tracking auto-submit, run right after the package dry-run evaluation.
//
// Each captured package the matcher decides is "exact" (lib/bfmrPackageMatch.ts)
// is sent on its own, as it arrives: a 2-unit box of a qty-4 line sends
// {qty 2, tracking A} now and the next box sends its own row later. A package
// that is not exact never blocks another exact package of the same order. The
// pure planning (which rows, which skips) is lib/bfmrAutoSubmitPlan.ts; the
// actual send is the shared core lib/bfmrSubmitReservation.ts, the same code
// the manual route runs, so BFMR is targeted the same way as a hand submit.
//
// Mode, from the app setting `bfmr_auto_submit`:
//   off  - do nothing
//   plan - (default when unset) log the rows that WOULD be sent, send nothing
//   on   - send
// Never throws into the capture path.
import { prisma, getSetting } from '@/lib/db';
import type { PackageDecision } from '@/lib/bfmrPackageMatch';
import { planAutoSubmit, parseAutoSubmitMode, type OrderFacts, type ReservationFacts } from '@/lib/bfmrAutoSubmitPlan';
import { submitReservationTracking } from '@/lib/bfmrSubmitReservation';

const TAG = '[bfmr/auto-submit]';
const rowsText = (rows: { qty: number; trackingNumber: string }[]) => JSON.stringify(rows);

// One send per reservation at a time: two captures landing together must not
// both pass the "not yet recorded" check and double-send.
const inFlight = new Set<number>();

function hasRejected(json: string | null): boolean {
  if (!json) return false;
  try { const v = JSON.parse(json); return Array.isArray(v) && v.length > 0; } catch { return false; }
}

export async function runAutoSubmit(userId: number, decisions: readonly PackageDecision[]): Promise<void> {
  try {
    const mode = parseAutoSubmitMode((await getSetting(userId, 'bfmr_auto_submit'))?.value);
    if (mode === 'off' || decisions.length === 0) return;

    const orderIds = [...new Set(decisions.map(d => d.orderId))];
    const reservationIds = [...new Set(decisions.flatMap(d => d.allocations.map(a => a.reservationId)))];
    const orderRows = await prisma.order.findMany({
      where: { userId, id: { in: orderIds } },
      select: { id: true, locked: true, cancelled: true, bfmrRejectedItems: true },
    });
    const resRows = reservationIds.length ? await prisma.bfmrReservation.findMany({
      where: { userId, id: { in: reservationIds } },
      select: { id: true, bfmrOrderId: true, myTrackerId: true, status: true, submittedShipments: { select: { trackingNumber: true } } },
    }) : [];
    const orders = new Map<number, OrderFacts>(orderRows.map(o => [o.id, { locked: o.locked, cancelled: o.cancelled, hasRejectedItems: hasRejected(o.bfmrRejectedItems) }]));
    const reservations = new Map<number, ReservationFacts>(resRows.map(r => [r.id, {
      bfmrOrderId: r.bfmrOrderId, myTrackerId: r.myTrackerId, status: r.status, submittedTrackings: r.submittedShipments.map(s => s.trackingNumber),
    }]));

    const plan = planAutoSubmit(decisions, orders, reservations);
    for (const s of plan.skips) {
      // A package already recorded is the normal steady state, not worth a line.
      if (/already[ _]submitted|already recorded/.test(s.reason)) continue;
      console.log(`${TAG} skip order ${s.orderId}${s.reservationId != null ? ` reservation ${s.reservationId}` : ''}: ${s.reason}`);
    }

    for (const p of plan.submits) {
      if (mode === 'plan') {
        console.log(`${TAG} plan reservation ${p.reservationId} order ${p.orderId} rows=${rowsText(p.rows)}`);
        continue;
      }
      if (inFlight.has(p.reservationId)) { console.log(`${TAG} skip reservation ${p.reservationId}: a send is already running`); continue; }
      inFlight.add(p.reservationId);
      try {
        const r = await submitReservationTracking(userId, p.reservationId, p.rows, 'auto');
        if (r.status === 200) console.log(`${TAG} sent reservation ${p.reservationId} order ${p.orderId} rows=${rowsText(p.rows)}${r.body.alreadySubmitted ? ' (already recorded)' : ''}`);
        else console.error(`${TAG} FAILED reservation ${p.reservationId} order ${p.orderId} rows=${rowsText(p.rows)}: ${r.status} ${String(r.body.error ?? '').slice(0, 300)}`);
      } catch (e) {
        console.error(`${TAG} FAILED reservation ${p.reservationId} order ${p.orderId}:`, String(e).slice(0, 300));
      } finally {
        inFlight.delete(p.reservationId);
      }
    }
  } catch (e) {
    console.error(`${TAG} run failed:`, String(e).slice(0, 300));
  }
}
