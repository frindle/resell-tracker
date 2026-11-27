// Pure planning for BFMR tracking auto-submit: from the package matcher's
// per-package decisions plus the facts about each order and reservation, work out which
// reservations get which tracking rows, and which orders are skipped and why.
// No DB, no I/O. The DB wiring and the actual send are lib/bfmrAutoSubmit.ts.
import type { PackageDecision, ReservationLineIn } from './bfmrPackageMatch.ts';
import { normTracking } from './bfmrLinkGuard.ts';import { canonicalBfmrTracking, findMissingBfmrId, type SubmitRow } from './bfmrSubmitFlow.ts';

export type AutoSubmitMode = 'off' | 'plan' | 'on';

/** Unset or unrecognised means plan: log what would be sent, send nothing. */
export function parseAutoSubmitMode(v: string | null | undefined): AutoSubmitMode {
  const s = (v ?? '').trim().toLowerCase();
  return s === 'off' || s === 'on' ? s : 'plan';
}

/** The most reservations one run may submit; above this nothing is sent. */
export const MAX_RESERVATIONS_PER_RUN = 5;

export interface OrderFacts { locked: boolean; cancelled: boolean; hasRejectedItems: boolean }
export interface ReservationFacts {
  bfmrOrderId: string | null;
  myTrackerId: number | null;
  status: string;
  /** tracking numbers already in BfmrSubmittedShipment for this reservation */
  submittedTrackings: string[];
}

export interface PlannedSubmit { orderId: number; reservationId: number; rows: SubmitRow[] }
export interface PlanSkip { orderId: number; reservationId?: number; reason: string }
export interface AutoSubmitPlan { submits: PlannedSubmit[]; skips: PlanSkip[] }

const SUBMIT_STATUSES = new Set(['purchased', 'shipped']);

export function planAutoSubmit(
  decisions: readonly PackageDecision[],
  orders: ReadonlyMap<number, OrderFacts>,
  reservations: ReadonlyMap<number, ReservationFacts>,
  cap = MAX_RESERVATIONS_PER_RUN,
): AutoSubmitPlan {
  const skips: PlanSkip[] = [];
  const rowsBy = new Map<number, { orderId: number; rows: SubmitRow[] }>();

  // Per package: an exact package goes out on its own; a manual one (or one
  // that fails a safety check) is skipped without holding back its siblings.
  for (const d of decisions) {
    const orderId = d.orderId;
    const skip = (reason: string, reservationId?: number) => skips.push({ orderId, reservationId, reason: `package ${d.trackingNumber}: ${reason}` });
    if (d.decision === 'manual') { skip(`needs a human (${d.reason})`); continue; }

    const o = orders.get(orderId);
    if (!o) { skip('order not found'); continue; }
    if (o.locked) { skip('order is locked'); continue; }
    if (o.cancelled) { skip('order is cancelled'); continue; }
    if (o.hasRejectedItems) { skip('order has rejected items'); continue; }
    if (d.allocations.length === 0) { skip('no allocations'); continue; }

    // All or nothing per package: one unsafe reservation holds back that package only.
    let blocked: { reason: string; reservationId: number } | null = null;
    for (const a of d.allocations) {
      const r = reservations.get(a.reservationId);
      if (!r) { blocked = { reason: 'reservation not found', reservationId: a.reservationId }; break; }
      const missing = findMissingBfmrId(r);
      if (missing) { blocked = { reason: `reservation has no ${missing}`, reservationId: a.reservationId }; break; }
      if (!SUBMIT_STATUSES.has((r.status ?? '').toLowerCase().trim())) { blocked = { reason: `reservation status is "${r.status}"`, reservationId: a.reservationId }; break; }
      if (r.submittedTrackings.some(t => canonicalBfmrTracking(t) === canonicalBfmrTracking(d.trackingNumber))) {
        blocked = { reason: 'tracking is already recorded for the reservation', reservationId: a.reservationId }; break;
      }
    }
    if (blocked) { skip(blocked.reason, blocked.reservationId); continue; }

    // One row per package per reservation.
    for (const a of d.allocations) {
      const entry = rowsBy.get(a.reservationId) ?? { orderId, rows: [] };
      const same = entry.rows.find(r => canonicalBfmrTracking(r.trackingNumber) === canonicalBfmrTracking(d.trackingNumber));
      if (same) same.qty += a.qty;
      else entry.rows.push({ qty: a.qty, trackingNumber: d.trackingNumber.trim() });
      rowsBy.set(a.reservationId, entry);
    }
  }

  const submits: PlannedSubmit[] = [...rowsBy].map(([reservationId, v]) => ({ orderId: v.orderId, reservationId, rows: v.rows }));
  if (submits.length > cap) {
    for (const c of submits) skips.push({ orderId: c.orderId, reservationId: c.reservationId, reason: `runaway cap: ${submits.length} reservations in one run (max ${cap})` });
    return { submits: [], skips };
  }
  return { submits, skips };
}

export interface ReplayRow { reservationId: number; qty: number; trackingNumber: string }

/** Does what the matcher would send equal what was recorded (by hand)? Same reservation, qty and tracking, in any order. */
export function replayVerdict(would: readonly ReplayRow[], recorded: readonly ReplayRow[]): 'agree' | 'disagree' | 'no_data' {
  if (would.length === 0 && recorded.length === 0) return 'no_data';
  const key = (r: ReplayRow) => `${r.reservationId}|${r.qty}|${canonicalBfmrTracking(r.trackingNumber)}`;
  const a = would.map(key).sort();
  const b = recorded.map(key).sort();
  return a.length === b.length && a.every((k, i) => k === b[i]) ? 'agree' : 'disagree';
}

/**
 * The reservation lines as they were before one package's tracking was
 * submitted: that tracking's BfmrSubmittedShipment rows (and the tracking BFMR
 * shows, when it is the same number) are dropped. Used by the replay so a
 * hand-submitted package is judged as if still waiting.
 */
export function withoutOwnSubmission(lines: readonly ReservationLineIn[], trackingNumber: string): ReservationLineIn[] {
  const t = normTracking(trackingNumber);
  return lines.map(l => ({
    ...l,
    trackingNumber: normTracking(l.trackingNumber) === t ? null : l.trackingNumber,
    submitted: l.submitted.filter(s => normTracking(s.trackingNumber) !== t),
  }));
}
