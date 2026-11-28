// The exact moment an order was placed, read from an order-placed email.
//
// Order.orderDate is a calendar date; Order.orderedAt is the instant, and the
// retailers' purchase limits count from it (see lib/resetLines.ts). Only an
// order-placed email gives it, and only when the email's time is the
// retailer's: a forward's own Date is when somebody forwarded it, which can be
// hours (or days) after the order.

/**
 * Where a message's `date` came from.
 *  - direct:             the message's own Date header (not forwarded)
 *  - forwarded-original: the retailer's Date line inside a forward, with a time zone
 *  - forwarded-unzoned:  the same, but written without a zone ("Nov 13, 2026 at 10:30 PM"): to the minute it is a guess
 *  - forward-time:       a forward with no readable original date: `date` is when it was forwarded
 */
export type DateSource = 'direct' | 'forwarded-original' | 'forwarded-unzoned' | 'forward-time';

const DAY_MS = 24 * 60 * 60 * 1000;

// A zone after a clock time: +0000, -08:00, GMT, UTC, Z, PST/PDT/EST/...
const ZONE_AFTER_TIME_RE = /\d{1,2}:\d{2}(?::\d{2})?\s*(?:[ap]\.?m\.?)?\s*(?:[+-]\d{2}:?\d{2}\b|(?:GMT|UTC|UT|Z|[ECMP][SD]T)\b)/i;

/** True when a header date names its time zone. */
export function hasExplicitZone(s: string): boolean {
  return ZONE_AFTER_TIME_RE.test(String(s ?? ''));
}

/**
 * The date a message should carry and where it came from.
 * `inner` is the retailer's Date line from a forwarded block as written (''
 * when none) and `innerParsed` that line parsed. An inner date later than the
 * forward (by more than a day, for clock skew) is nonsense and ignored.
 * `forwarded` is true for any forward, including one whose block could not be
 * unwrapped (its subject still says Fwd:).
 */
export function chooseEmailDate(o: { outer: Date | undefined; inner: string; innerParsed: Date | null; forwarded: boolean }): { date: Date | undefined; source: DateSource } {
  const { outer, inner, innerParsed, forwarded } = o;
  if (innerParsed && (!outer || innerParsed.getTime() <= outer.getTime() + DAY_MS)) {
    return { date: innerParsed, source: hasExplicitZone(inner) ? 'forwarded-original' : 'forwarded-unzoned' };
  }
  return { date: outer, source: forwarded ? 'forward-time' : 'direct' };
}

/** True when a date from this source is the retailer's own time, good to the minute. */
export function isRetailerTime(source: DateSource | undefined): boolean {
  return source === 'direct' || source === 'forwarded-original';
}

type EmailLike = { kind: string; date: string; undated?: boolean; dateSource?: DateSource };

/**
 * The order time (ISO) an email states, or null. Only an order-placed email
 * counts (not shipping, delivery or cancel), never an undated one, and never a
 * forward's own time.
 */
export function emailOrderedAt(e: EmailLike): string | null {
  if (e.kind !== 'ordered' || e.undated || !isRetailerTime(e.dateSource)) return null;
  return Number.isNaN(new Date(e.date).getTime()) ? null : new Date(e.date).toISOString();
}

/** The same rule for a Costco eGift delivery email (any kind): the retailer's delivery time, or null. */
export function emailDeliveredAt(e: Omit<EmailLike, 'kind'>): string | null {
  if (e.undated || !isRetailerTime(e.dateSource)) return null;
  return Number.isNaN(new Date(e.date).getTime()) ? null : new Date(e.date).toISOString();
}

/**
 * What to write to a time column that is only filled or moved earlier: the
 * incoming time when the column is empty or the incoming time is earlier,
 * otherwise undefined (leave it). An unreadable incoming value is ignored.
 */
export function earlierTime(existing: Date | null | undefined, incoming: string | Date | null | undefined): Date | undefined {
  if (incoming == null || incoming === '') return undefined;
  const t = incoming instanceof Date ? incoming : new Date(incoming);
  if (Number.isNaN(t.getTime())) return undefined;
  if (existing && existing.getTime() <= t.getTime()) return undefined;
  return t;
}
