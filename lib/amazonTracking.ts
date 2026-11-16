// Tracking numbers for Amazon orders whose shipped email had none (Amazon
// never puts the carrier number in its emails). Penn's call, 2026-11-15:
// the sidecar tries the order's tracking page first; when Amazon blocks it,
// signs it out or it fails, the Brave extension opens the same pages in a
// minimized window. Neither one gets past a block page: both stop there.
//
// Queued as TRACK_AMAZON commands with payload { orderNumbers, userId }.
// Only the user the sidecar imports as (TRACKER_USER_ID, user 1 by default)
// is handled: that is the Amazon account both browsers are signed in to.
// Pure helpers here; lib/amazonTrackingQueue.ts does the database work.

export const TRACK_AMAZON = 'TRACK_AMAZON';

/** After the sidecar is blocked, skip it and go straight to Brave for this long. */
export const SIDECAR_BLOCK_SKIP_MS = 24 * 60 * 60 * 1000;

/** A running command older than this is treated as dead, so its orders can be queued again. */
export const RUNNING_STALE_MS = 30 * 60 * 1000;

export type TrackTarget = 'sidecar' | 'chrome';

export type TrackPayload = { orderNumbers: string[]; userId: number; from?: string; reason?: string };

const digits = (s: string) => String(s ?? '').replace(/\D/g, '');

export function trackingUserId(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.TRACKER_USER_ID ?? env.SIDECAR_TRACKER_USER_ID ?? 1);
  return Number.isInteger(n) && n > 0 ? n : 1;
}

/** 'chrome' (the Brave extension) when the sidecar was blocked in the last day, else 'sidecar'. */
export function pickTrackingTarget(status: string | null | undefined, checkedAt: string | null | undefined, now: number): TrackTarget {
  if (status !== 'blocked') return 'sidecar';
  const at = Date.parse(String(checkedAt ?? ''));
  return Number.isFinite(at) && now - at < SIDECAR_BLOCK_SKIP_MS ? 'chrome' : 'sidecar';
}

export function parseTrackPayload(json: string | null | undefined): TrackPayload | null {
  if (!json) return null;
  try {
    const p = JSON.parse(json) as Partial<TrackPayload>;
    if (!Array.isArray(p.orderNumbers)) return null;
    return { ...p, orderNumbers: p.orderNumbers.map(String).filter(Boolean), userId: Number(p.userId) } as TrackPayload;
  } catch {
    return null;
  }
}

/** Amazon order numbers ("111-2223334-4445556") not already waiting in a queued command, deduped. */
export function ordersToQueue(wanted: readonly string[], inFlight: readonly (TrackPayload | null)[]): string[] {
  const busy = new Set(inFlight.flatMap(p => (p ? p.orderNumbers.map(digits) : [])));
  const out: string[] = [];
  for (const o of wanted) {
    const d = digits(o);
    // Amazon order numbers are 17 digits; anything else isn't one.
    if (d.length !== 17 || busy.has(d)) continue;
    busy.add(d);
    out.push(o.trim());
  }
  return out;
}

/** Adds orders to a pending command's payload instead of queueing a second command. */
export function mergeTrackPayload(existing: TrackPayload | null, add: TrackPayload): TrackPayload {
  if (!existing) return add;
  const seen = new Set(existing.orderNumbers.map(digits));
  const extra = add.orderNumbers.filter(o => { const d = digits(o); if (seen.has(d)) return false; seen.add(d); return true; });
  return { ...existing, orderNumbers: [...existing.orderNumbers, ...extra] };
}

/**
 * Pushover text when the Brave extension could not finish a TRACK_AMAZON
 * (the sidecar hands its failures to Brave, so it never alerts). No order
 * numbers or item names.
 */
export function trackFailedText(payload: TrackPayload | null, result: { error?: string; blocked?: boolean } | null): string {
  const n = payload?.orderNumbers.length ?? 0;
  const what = `${n || 'Some'} Amazon order${n === 1 ? '' : 's'}`;
  if (result?.blocked) {
    return `${what} still need tracking. Brave stopped at Amazon's sign-in or check page: open the minimized Brave window, finish it there, and the next shipped email will try again.`;
  }
  return `${what} still need tracking. Brave couldn't read Amazon's tracking page${result?.error ? ` (${String(result.error).slice(0, 120)})` : ''}. Open the order on Amazon and add it by hand.`;
}
