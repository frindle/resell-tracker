// Tracking numbers for Amazon orders whose shipped email had none (Amazon
// never puts the carrier number in its emails). The Brave extension opens
// the order's tracking page in a minimized window and reads it; it stops at
// an Amazon block or sign-in page.
//
// Queued as TRACK_AMAZON commands with payload { orderNumbers, userId }.
// Only the user the tracker imports as (TRACKER_USER_ID, user 1 by default)
// is handled: that is the Amazon account the browser is signed in to.
// Pure helpers here; lib/amazonTrackingQueue.ts does the database work.

export const TRACK_AMAZON = 'TRACK_AMAZON';

/** A running command older than this is treated as dead, so its orders can be queued again. */
export const RUNNING_STALE_MS = 30 * 60 * 1000;

export type TrackPayload = { orderNumbers: string[]; userId: number; from?: string; reason?: string };

const digits = (s: string) => String(s ?? '').replace(/\D/g, '');

export function trackingUserId(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.TRACKER_USER_ID ?? env.SIDECAR_TRACKER_USER_ID ?? 1);
  return Number.isInteger(n) && n > 0 ? n : 1;
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
 * No order numbers or item names.
 */
export function trackFailedText(payload: TrackPayload | null, result: { error?: string; blocked?: boolean } | null): string {
  const n = payload?.orderNumbers.length ?? 0;
  const what = `${n || 'Some'} Amazon order${n === 1 ? '' : 's'}`;
  if (result?.blocked) {
    return `${what} still need tracking. Brave stopped at Amazon's sign-in or check page: open the minimized Brave window, finish it there, and the next shipped email will try again.`;
  }
  return `${what} still need tracking. Brave couldn't read Amazon's tracking page${result?.error ? ` (${String(result.error).slice(0, 120)})` : ''}. Open the order on Amazon and add it by hand.`;
}
