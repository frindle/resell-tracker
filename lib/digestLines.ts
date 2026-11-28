// Lines for the "Resell" section of the daily homelab digest email.
//
// The ollama-queue on Unraid sends one digest email a day (05:07, covering the
// day before). Apps add their own section by POSTing lines to
// /api/digest-lines. lib/digestRunner.ts counts from the DB and runs the
// timer; this file builds the lines, works out LA calendar days and makes the
// POST (with fetch passed in, so it is testable without a network).
//
// The lines are counts, plus the product names and times of purchase limits
// that reset that morning (lib/resetLines.ts): no order numbers, addresses or amounts.
// The queue turns away the whole POST if any line looks private (an @, a
// currency sign or word, an amount with cents, six digits in a row), so a line
// that would trip that is rewritten or dropped here rather than failing the day.

import { MAX_LINE_CHARS, lineLooksPrivate, cutLine } from './digestPrivate.ts';
import { la, shiftDay, laMidnight } from './laDay.ts';
import { buildResetLines, RESET_LINE_BUDGET, type ResetOrder } from './resetLines.ts';

export type DigestCounts = {
  /** Orders created that day, by platform (cancelled ones left out). */
  ordersAdded: Record<string, number>;
  /** Of those, how many still have no card set. */
  addedWithoutCard: number;
  /** Order sync runs that day, and orders they created or updated. */
  syncRuns: number;
  syncOrdersChanged: number;
  /** Gift cards submitted to CardCenter that day. */
  cardsSubmitted: number;
  /** Now: orders with a ship-by date and no tracking, and how many are past it. */
  waitingToShip: number;
  pastShipBy: number;
  /** Now: API errors not yet opened on /api-errors. */
  unseenErrors: number;
  /**
   * The orders whose purchase limits could reset on the day after `day`
   * (lib/resetLines.ts): the lines for LA day D are read on D+1, so these are
   * the resets that happen on the morning they are read.
   */
  resets?: { day: string; orders: ResetOrder[] };
};

export { MAX_LINE_CHARS, lineLooksPrivate, laMidnight };
export const MAX_LINES = 10;

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function buildDigestLines(c: DigestCounts): { lines: string[]; needsYou: boolean } {
  const lines: string[] = [];

  const added = Object.entries(c.ordersAdded).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const total = added.reduce((s, [, n]) => s + n, 0);
  if (total === 0) {
    lines.push('No new orders.');
  } else {
    const by = added.length > 1 ? ` (${added.map(([p, n]) => `${p} ${n}`).join(', ')})` : ` (${added[0][0]})`;
    const detailed = `${plural(total, 'new order')}${by}.`;
    // A platform name the queue would refuse costs the breakdown, not the count. Tested as sent (cut).
    lines.push(lineLooksPrivate(cutLine(detailed)) ? `${plural(total, 'new order')}.` : detailed);
  }
  if (c.addedWithoutCard > 0) lines.push(`${plural(c.addedWithoutCard, 'new order')} with no card set.`);
  if (c.syncRuns > 0) lines.push(`Order syncs: ${plural(c.syncRuns, 'run')}, ${plural(c.syncOrdersChanged, 'order')} added or updated.`);
  if (c.cardsSubmitted > 0) lines.push(`${plural(c.cardsSubmitted, 'gift card')} submitted to CardCenter.`);
  if (c.waitingToShip > 0) {
    const late = c.pastShipBy > 0 ? `, ${c.pastShipBy} past the ship-by date` : '';
    lines.push(`Waiting on tracking: ${plural(c.waitingToShip, 'order')}${late}.`);
  }
  if (c.unseenErrors > 0) lines.push(`Unread API errors: ${c.unseenErrors}.`);

  // The count lines come first and keep their place; the reset lines share what is left, up to RESET_LINE_BUDGET.
  const counted = lines.map(cutLine).filter(l => !lineLooksPrivate(l)).slice(0, MAX_LINES);
  if (c.resets) counted.push(...buildResetLines(c.resets.day, c.resets.orders, Math.min(RESET_LINE_BUDGET, MAX_LINES - counted.length)));

  return {
    // Cut, then test: the queue tests the line it receives, and a cut can end on a refused word ("…Eurostar" -> "…Eur").
    lines: counted.slice(0, MAX_LINES),
    // An order past its ship-by date with no tracking is the one thing here
    // that costs money if nobody looks.
    needsYou: c.pastShipBy > 0,
  };
}

/** The LA calendar day `daysBack` days before `now`, as [start, end). */
export function dayWindow(now: Date, daysBack: number): { day: string; start: Date; end: Date } {
  const day = shiftDay(la(now).day, -daysBack);
  return { day, start: laMidnight(day), end: laMidnight(shiftDay(day, 1)) };
}

/**
 * Which days to post on a tick (as days back). Today, always. Yesterday too
 * until the 05:07 digest run has read it, so it reports the final counts.
 */
export function daysToPost(now: Date, digestHour = 6): number[] {
  return la(now).hour < digestHour ? [1, 0] : [0];
}

export type PostResult = { result: 'sent' | 'skipped' | 'failed'; status?: number; error?: string };

/**
 * One POST, 10 s timeout, no retry (the next hourly tick re-sends anyway).
 * Skipped, not failed, when the env isn't set, on 404 (a queue without the
 * route) and on 503 (the queue has no key yet).
 */
export async function postDigestLines(
  day: string,
  lines: string[],
  needsYou: boolean,
  env: { url?: string; token?: string } = { url: process.env.DIGEST_QUEUE_URL, token: process.env.DIGEST_QUEUE_TOKEN },
  fetchFn: typeof fetch = fetch,
): Promise<PostResult> {
  if (!env.url || !env.token) return { result: 'skipped' };
  try {
    const res = await fetchFn(`${env.url.replace(/\/+$/, '')}/api/digest-lines`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ app: 'resell', day, lines, needs_you: needsYou }),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) return { result: 'sent', status: res.status };
    if (res.status === 404 || res.status === 503) return { result: 'skipped', status: res.status };
    let error = '';
    try { error = (await res.text()).slice(0, 200); } catch { /* body unreadable */ }
    return { result: 'failed', status: res.status, error };
  } catch (e) {
    return { result: 'failed', error: (e instanceof Error ? e.message : String(e)).slice(0, 200) };
  }
}
