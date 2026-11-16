// Lines for the "Resell" section of the daily homelab digest email.
//
// The ollama-queue on Unraid sends one digest email a day (05:07, covering the
// day before). Apps add their own section by POSTing lines to
// /api/digest-lines. lib/digestRunner.ts counts from the DB and runs the
// timer; this file builds the lines, works out LA calendar days and makes the
// POST (with fetch passed in, so it is testable without a network).
//
// The lines are counts only: no order numbers, names, addresses or amounts.
// The queue turns away any line with an @, a $ or six digits in a row, so
// lines that would trip that are dropped here rather than failing the POST.

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
};

export const MAX_LINES = 10;
export const MAX_LINE_CHARS = 200;

/** Mirrors the queue's check, so a line it would reject is never sent. */
export function lineLooksPrivate(line: string): boolean {
  return /@|\$|\d{6,}/.test(line);
}

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
    lines.push(`${plural(total, 'new order')}${by}.`);
  }
  if (c.addedWithoutCard > 0) lines.push(`${plural(c.addedWithoutCard, 'new order')} with no card set.`);
  if (c.syncRuns > 0) lines.push(`Order syncs: ${plural(c.syncRuns, 'run')}, ${plural(c.syncOrdersChanged, 'order')} added or updated.`);
  if (c.cardsSubmitted > 0) lines.push(`${plural(c.cardsSubmitted, 'gift card')} submitted to CardCenter.`);
  if (c.waitingToShip > 0) {
    const late = c.pastShipBy > 0 ? `, ${c.pastShipBy} past the ship-by date` : '';
    lines.push(`Waiting on tracking: ${plural(c.waitingToShip, 'order')}${late}.`);
  }
  if (c.unseenErrors > 0) lines.push(`Unread API errors: ${c.unseenErrors}.`);

  return {
    lines: lines.filter(l => !lineLooksPrivate(l)).map(l => l.slice(0, MAX_LINE_CHARS)).slice(0, MAX_LINES),
    // An order past its ship-by date with no tracking is the one thing here
    // that costs money if nobody looks.
    needsYou: c.pastShipBy > 0,
  };
}

// Days are LA calendar days, worked out explicitly: the container's own time
// zone isn't set, and the queue reads "day" in LA time.
const laFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

function la(at: Date): { day: string; hour: number; wallAsUtc: number } {
  const p: Record<string, string> = {};
  for (const x of laFmt.formatToParts(at)) p[x.type] = x.value;
  return {
    day: `${p.year}-${p.month}-${p.day}`,
    hour: Number(p.hour),
    wallAsUtc: Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second),
  };
}

function shiftDay(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** The instant LA calendar day `day` (YYYY-MM-DD) starts. DST-safe: it changes at 02:00, never midnight. */
export function laMidnight(day: string): Date {
  const utcMidnight = Date.parse(`${day}T00:00:00Z`);
  let t = utcMidnight;
  for (let i = 0; i < 2; i++) t = utcMidnight - (la(new Date(t)).wallAsUtc - t);
  return new Date(t);
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
