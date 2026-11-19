// Effective-dated card rates. A card keeps a history of rate entries, each
// with a start day; an order earns at the entry in effect on its order date.
// The card's own rewardsRate / basePointsPerDollar columns hold the rate in
// effect today (kept in step by the card routes) and are the fallback for a
// card with no history.
//
// Pure, no I/O.
import { formatOrderDateIso, isDateOnlyOrderDate } from './formatOrderDate.ts';

/** Start day of the first entry every card gets: earlier than any order. */
export const ORIGINAL_FROM = '0001-01-01';

export type RateEntry = {
  /** YYYY-MM-DD, the first day the rate applies. */
  effectiveFrom: string;
  rewardsRate: number | null;
  basePointsPerDollar: number | null;
};

export type CardWithRates = {
  rewardsRate?: number | null;
  basePointsPerDollar?: number | null;
  rateHistory?: RateEntry[] | null;
};

/** The business day. The server runs in UTC and the browser in Pacific, so both use this zone explicitly. */
export const RATE_TIME_ZONE = 'America/Los_Angeles';

const PACIFIC_DAY = new Intl.DateTimeFormat('en-US', { timeZone: RATE_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });

function pacificDay(d: Date): string {
  if (isNaN(d.getTime())) return '';
  const p = Object.fromEntries(PACIFIC_DAY.formatToParts(d).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

/** Today's business day (Pacific), YYYY-MM-DD. */
export function todayKey(now: Date = new Date()): string {
  return pacificDay(now);
}

/**
 * The calendar day an order date or a YYYY-MM-DD string falls on. A date-only
 * stored value (UTC midnight) keeps its own day; a real timestamp is read in
 * Pacific time on both server and client.
 */
export function dayKey(date: string | Date): string {
  if (typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
  const d = typeof date === 'string' ? new Date(date) : date;
  if (isNaN(d.getTime())) return '';
  if (isDateOnlyOrderDate(date)) return formatOrderDateIso(date);
  return pacificDay(d);
}

/**
 * Where a plain card edit that sets the current rate should write, or null
 * when nothing changes. Older entries are never rewritten: a rate change adds
 * (or replaces) the entry that starts today. The one exception is an original
 * entry that never held a rate, which is filled in.
 */
export function currentRateTarget(
  history: RateEntry[] | null | undefined,
  rewardsRate: number | null,
  basePointsPerDollar: number | null,
  today: string = todayKey(),
): string | null {
  const e = rateEntryOn(history, today);
  if (!e) return ORIGINAL_FROM;
  if (e.rewardsRate === rewardsRate && e.basePointsPerDollar === basePointsPerDollar) return null;
  if (e.effectiveFrom === ORIGINAL_FROM && e.rewardsRate == null && e.basePointsPerDollar == null) return ORIGINAL_FROM;
  return today;
}

/** The entry in effect on `date`: the latest start day on or before it, else the earliest entry. */
export function rateEntryOn(history: RateEntry[] | null | undefined, date: string | Date): RateEntry | null {
  if (!history || history.length === 0) return null;
  const key = dayKey(date);
  const sorted = [...history].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  let hit = sorted[0];
  for (const e of sorted) if (e.effectiveFrom <= key) hit = e;
  return hit;
}

/** The cashback % and points multiplier that apply to an order placed on `date`. */
export function ratesOn(card: CardWithRates, date: string | Date | null | undefined): { rewardsRate: number | null; basePointsPerDollar: number | null } {
  const e = date ? rateEntryOn(card.rateHistory, date) : null;
  if (e) return { rewardsRate: e.rewardsRate, basePointsPerDollar: e.basePointsPerDollar };
  return { rewardsRate: card.rewardsRate ?? null, basePointsPerDollar: card.basePointsPerDollar ?? null };
}
