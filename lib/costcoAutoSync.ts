import { isSignInNeededResult } from './syncStatus.ts';

// When to queue the automatic Costco sync for the browser extension. Pure:
// lib/costcoAutoSyncQueue.ts reads the rows and acts on the answer.
//
// Rule: at most one SYNC_COSTCO per `hours`, counted from the last one that
// finished (a hand-pressed Sync counts too). Never while a Costco command is
// waiting or running. After a result that says sign-in is needed it waits a
// day instead, so a signed-out browser is not poked all day. The moment is
// pushed a few minutes past the due time at random so it never lands on the
// hour.

export const COSTCO_AUTO_HOURS_KEY = 'costco_auto_sync_hours';
export const COSTCO_AUTO_STATE_KEY = 'costco_auto_sync_state';
export const DEFAULT_HOURS = 6;
export const MAX_HOURS = 72;
export const SIGN_IN_BACKOFF_HOURS = 24;
/** A running command not touched for this long is treated as dead. */
export const RUNNING_STALE_MS = 30 * 60_000;
/** A pending command older than this is described as waiting for the browser. */
export const PENDING_STALE_MS = 60 * 60_000;
const HOUR_MS = 3_600_000;
const JITTER_MIN_MS = 3 * 60_000;
const JITTER_SPAN_MS = 27 * 60_000;

/** The saved setting as whole hours: 0 = off, blank or junk = the default, capped at MAX_HOURS. */
export function sanitizeHours(raw: unknown): number {
  const s = String(raw ?? '').trim();
  if (!s) return DEFAULT_HOURS;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_HOURS;
  return Math.min(MAX_HOURS, Math.floor(n));
}

/** What was worked out last time, so the random delay stays the same between polls. */
export type AutoState = { dueAt: number | null; basis: string | null };
export const EMPTY_STATE: AutoState = { dueAt: null, basis: null };

export function parseState(raw: string | null | undefined): AutoState {
  try {
    const v = JSON.parse(raw ?? '');
    const dueAt = typeof v?.dueAt === 'number' && Number.isFinite(v.dueAt) ? v.dueAt : null;
    const basis = typeof v?.basis === 'string' ? v.basis : null;
    return dueAt != null && basis != null ? { dueAt, basis } : EMPTY_STATE;
  } catch {
    return EMPTY_STATE;
  }
}

export type CostcoRow = { type: string; status: string; result: string | null; updatedAt: number };

export type AutoPlan = {
  queue: boolean;
  state: AutoState;
  enabled: boolean;
  hours: number;
  inFlight: boolean;
  /** A SYNC_COSTCO has been pending over an hour: the browser is probably closed. */
  waitingForBrowser: boolean;
  signInNeeded: boolean;
  lastAt: number | null;
  nextAt: number | null;
};

const isCostco = (t: string) => t === 'SYNC_COSTCO' || t === 'SYNC_COSTCO_ORDER';

export function planCostcoAutoSync(input: {
  now: number;
  hours: number;
  rows: readonly CostcoRow[];
  state: AutoState;
  /** 0 <= x < 1; passed in so tests can pin the delay. */
  rand?: () => number;
}): AutoPlan {
  const { now, hours, state } = input;
  const rand = input.rand ?? Math.random;
  const costco = input.rows.filter(r => isCostco(r.type));
  // A pending SYNC_COSTCO blocks however old it is: with the browser closed a new one every
  // interval would only pile up. Its age only changes the status text. A pending
  // per-order command still stops counting after an hour.
  const pendingSync = costco.filter(r => r.type === 'SYNC_COSTCO' && r.status === 'pending');
  const inFlight = pendingSync.length > 0 || costco.some(r =>
    (r.status === 'pending' && now - r.updatedAt < PENDING_STALE_MS) ||
    (r.status === 'running' && now - r.updatedAt < RUNNING_STALE_MS));
  const waitingForBrowser = pendingSync.some(r => now - r.updatedAt >= PENDING_STALE_MS);
  const finished = costco
    .filter(r => r.type === 'SYNC_COSTCO' && (r.status === 'done' || r.status === 'failed'))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const last = finished[0] ?? null;
  const signInNeeded = !!last && last.status === 'failed' && isSignInNeededResult(last.result);
  const lastAt = last ? last.updatedAt : null;
  const base = { enabled: hours > 0, hours, inFlight, waitingForBrowser, signInNeeded, lastAt };

  if (hours <= 0) return { ...base, queue: false, state: EMPTY_STATE, nextAt: null };
  if (inFlight) return { ...base, queue: false, state, nextAt: state.dueAt };

  const interval = (signInNeeded ? SIGN_IN_BACKOFF_HOURS : hours) * HOUR_MS;
  const basis = `${lastAt ?? 0}:${interval}`;
  let dueAt = state.basis === basis ? state.dueAt : null;
  if (dueAt == null) {
    const earliest = lastAt == null ? now : Math.max(now, lastAt + interval);
    dueAt = earliest + JITTER_MIN_MS + Math.floor(rand() * JITTER_SPAN_MS);
  }
  if (now >= dueAt) return { ...base, queue: true, state: EMPTY_STATE, nextAt: null };
  return { ...base, queue: false, state: { dueAt, basis }, nextAt: dueAt };
}
