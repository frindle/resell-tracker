// The merchant's own expected delivery day ("Arriving Nov 30", "Now expected Dec 2", "Arrives by Fri, Nov 28",
// "Expected Nov 28 - Dec 2"), read from an Amazon or Walmart page, an order / shipping / delay email, or a
// carrier page's "Estimated delivery" line. Pure: lib/expectedDeliveryDb.ts writes it.
//
// Days are calendar days held as 00:00 UTC. Relative words ("today", "tomorrow", "Friday") are resolved against
// the day the text was SEEN (the anchor), never against the current time, so a replayed old page gives the
// date it meant. A text that does not clearly give a day gives null, never a guess.

export type ExpectedRange = { start: Date; end: Date };
export type ExpectedSource = 'amazon-page' | 'walmart-page' | 'email' | 'carrier';
export const EXPECTED_SOURCES: readonly ExpectedSource[] = ['amazon-page', 'walmart-page', 'email', 'carrier'];

const DAY_MS = 86_400_000;
/** A range longer than this was misread (two unrelated dates), so only its first part is used. */
export const MAX_RANGE_DAYS = 21;

const MON = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const WD = '(?:mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)';
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

// What introduces an expected date. "Delivered ..." is deliberately not here: that is a fact, not an expectation.
const KEY = /\b(?:now\s+)?(?:arriv(?:ing|es|al)|expected(?:\s+delivery)?|estimated\s+delivery(?:\s+date)?|delivery\s+(?:estimate|date)|deliver(?:y)?\s+by|get\s+it\s+by|will\s+arrive)\b[\s:,]*(?:(?:by|on|between|before)\b[\s:,]*)?/gi;

const WD_PREFIX = `(?:${WD}\\.?,?\\s+)?`;
// One day: today | tomorrow | [Fri,] Nov 28[th] | [Fri,] 11/28[/2026] | Friday
const DAY_RE = new RegExp(
  `^(?:(today|tomorrow)\\b|${WD_PREFIX}(${MON})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(\\d{4}))?|${WD_PREFIX}(\\d{1,2})/(\\d{1,2})(?:/(\\d{4}|\\d{2}))?(?![\\d/])|(${WD})\\b)`,
  'i',
);
const RANGE_SEP = /^\s*(?:-|–|—|to|and)\s*/i;
// The end of "Nov 28-30" (just a day number) or of "Thursday - Saturday".
const END_DAY_ONLY = /^(\d{1,2})(?:st|nd|rd|th)?\b(?!\s*(?::|\/|am\b|pm\b|a\.m|p\.m))/i;

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d));
const validYmd = (dt: Date, m: number, d: number) => dt.getUTCMonth() === m && dt.getUTCDate() === d;

/** The Pacific calendar day of an instant (the zone the group deadlines and the delivery dates here use), as 00:00 UTC. */
export function pacificDay(d: Date): Date | null {
  if (!(d instanceof Date) || !Number.isFinite(d.getTime())) return null;
  const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
  const n = (t: string) => Number(p.find(x => x.type === t)?.value);
  return utc(n('year'), n('month') - 1, n('day'));
}

type Day = { date: Date; len: number };

/** The year a month/day with no year means: the one that puts it nearest the anchor day. */
function nearestYear(anchor: Date, m: number, d: number): Date | null {
  let best: Date | null = null;
  for (const y of [anchor.getUTCFullYear() - 1, anchor.getUTCFullYear(), anchor.getUTCFullYear() + 1]) {
    const c = utc(y, m, d);
    if (!validYmd(c, m, d)) continue;
    if (!best || Math.abs(c.getTime() - anchor.getTime()) < Math.abs(best.getTime() - anchor.getTime())) best = c;
  }
  return best;
}

function nextWeekday(from: Date, wd: number): Date {
  return new Date(from.getTime() + ((wd - from.getUTCDay() + 7) % 7) * DAY_MS);
}

function readDay(s: string, anchor: Date): Day | null {
  const m = DAY_RE.exec(s);
  if (!m) return null;
  const len = m[0].length;
  if (m[1]) return { date: new Date(anchor.getTime() + (m[1].toLowerCase() === 'tomorrow' ? DAY_MS : 0)), len };
  if (m[2]) {
    const mo = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase()), d = +m[3];
    const date = m[4] ? utc(+m[4], mo, d) : nearestYear(anchor, mo, d);
    return date && validYmd(date, mo, d) ? { date, len } : null;
  }
  if (m[5]) {
    const mo = +m[5] - 1, d = +m[6];
    if (mo < 0 || mo > 11) return null;
    const y = m[7] ? (m[7].length === 2 ? 2000 + +m[7] : +m[7]) : null;
    const date = y != null ? utc(y, mo, d) : nearestYear(anchor, mo, d);
    return date && validYmd(date, mo, d) ? { date, len } : null;
  }
  return { date: nextWeekday(anchor, WEEKDAYS.indexOf(m[8].slice(0, 3).toLowerCase())), len };
}

/** The end of a range that began at `start`: "Dec 2", "30" (same month), "Saturday". Null when there is none. */
function readRangeEnd(s: string, start: Date): Day | null {
  const sep = RANGE_SEP.exec(s);
  if (!sep) return null;
  const rest = s.slice(sep[0].length);
  const full = readDay(rest, start);
  if (full) {
    // "Dec 28 - Jan 2": a month/day with no year resolves to the one nearest the start, so it lands after it.
    const date = full.date;
    return { date, len: sep[0].length + full.len };
  }
  const only = END_DAY_ONLY.exec(rest);
  if (only) {
    const d = +only[1];
    let date = utc(start.getUTCFullYear(), start.getUTCMonth(), d);
    if (date.getTime() < start.getTime()) date = utc(start.getUTCFullYear(), start.getUTCMonth() + 1, d);
    return validYmd(date, date.getUTCMonth(), d) ? { date, len: sep[0].length + only[0].length } : null;
  }
  return null;
}

/**
 * The expected delivery in `text`, relative to the Pacific calendar day of `seenAt`. Several mentions (an order with
 * packages arriving on different days) become one range from the earliest to the latest, unless that is
 * implausibly long, in which case the first mention alone is used. Null when nothing clear is found.
 */
export function parseExpectedDelivery(text: string, seenAt: Date): ExpectedRange | null {
  const day0 = pacificDay(seenAt);
  if (!day0) return null;
  const s = String(text ?? '').replace(/\s+/g, ' ');
  const found: ExpectedRange[] = [];
  for (const k of s.matchAll(KEY)) {
    const rest = s.slice(k.index! + k[0].length);
    const a = readDay(rest, day0);
    if (!a) continue;
    const b = readRangeEnd(rest.slice(a.len), a.date);
    const r = b && b.date.getTime() >= a.date.getTime() ? { start: a.date, end: b.date } : { start: a.date, end: a.date };
    if (r.end.getTime() - r.start.getTime() > MAX_RANGE_DAYS * DAY_MS) continue;
    // A date months from the anchor is a misread (or an old page), not an expectation.
    if (r.end.getTime() < day0.getTime() - 60 * DAY_MS || r.start.getTime() > day0.getTime() + 150 * DAY_MS) continue;
    found.push(r);
  }
  if (!found.length) return null;
  const start = new Date(Math.min(...found.map(r => r.start.getTime())));
  const end = new Date(Math.max(...found.map(r => r.end.getTime())));
  return end.getTime() - start.getTime() <= MAX_RANGE_DAYS * DAY_MS ? { start, end } : found[0];
}

export type ExpectedStored = { start: Date | null; end: Date | null; source: string | null; seenAt: Date | null };
export type ExpectedIncoming = { start: Date; end: Date; source: ExpectedSource; seenAt: Date };

/**
 * Whether an observation replaces what the order has. The most recently SEEN one wins, not the latest date, and
 * an older sighting never overwrites a newer one (so replaying an old page or an old email is harmless).
 */
export function decideExpected(existing: ExpectedStored | null, incoming: ExpectedIncoming, now: Date = new Date()): 'write' | 'skip' {
  const t = incoming.seenAt?.getTime();
  if (!Number.isFinite(t) || !Number.isFinite(incoming.start?.getTime()) || !Number.isFinite(incoming.end?.getTime())) return 'skip';
  if (incoming.end.getTime() < incoming.start.getTime()) return 'skip';
  if (!EXPECTED_SOURCES.includes(incoming.source)) return 'skip';
  // A sighting dated well after now (a bad email date) cannot beat everything that comes later.
  if (t > now.getTime() + DAY_MS) return 'skip';
  if (!existing || !existing.seenAt || !existing.start || !existing.end) return 'write';
  return t > existing.seenAt.getTime() ? 'write' : 'skip';
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayText = (d: Date) => `${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCDate()}`;

/** "Nov 30" or "Nov 28–Dec 2" (same month: "Nov 28–30"). */
export function expectedRangeText(start: Date, end: Date): string {
  if (start.getTime() === end.getTime()) return dayText(start);
  if (start.getUTCMonth() === end.getUTCMonth()) return `${dayText(start)}–${end.getUTCDate()}`;
  return `${dayText(start)}–${dayText(end)}`;
}

const SOURCE_LABEL: Record<string, string> = { 'amazon-page': 'Amazon page', 'walmart-page': 'Walmart page', email: 'email', carrier: 'carrier page' };

export type ExpectedDelivery = { start: Date; end: Date; source: string | null; seenAt: Date | null };

export type ExpectedDisplay = {
  /** "Arriving Nov 30", "Expected Nov 28–Dec 2" or "Late · expected Nov 25". */
  text: string;
  late: boolean;
  /** Where the date came from and when it was seen. */
  tooltip: string;
};

/**
 * What to show for an expected delivery. Late when the whole window is behind today (Pacific) (the
 * caller only asks for orders that are not delivered).
 */
export function expectedDisplay(e: ExpectedDelivery, now: Date): ExpectedDisplay {
  const today = pacificDay(now)?.getTime() ?? Date.now();
  const late = e.end.getTime() < today;
  const range = expectedRangeText(e.start, e.end);
  const single = e.start.getTime() === e.end.getTime();
  const text = late ? `Late · expected ${range}` : single ? `Arriving ${range}` : `Expected ${range}`;
  const from = e.source ? SOURCE_LABEL[e.source] ?? e.source : 'merchant';
  const seen = e.seenAt ? `, seen ${dayText(e.seenAt)}` : '';
  return { text, late, tooltip: `${late ? 'Late · expected' : 'Expected'} ${range} (from ${from}${seen})` };
}
