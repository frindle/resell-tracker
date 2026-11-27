// Reads the visible text of a FedEx or UPS public tracking page (document.body.innerText, sent by the browser
// extension) and says whether the package was delivered and when.
//
// The pages show the local date and time at the delivery place with no zone. We keep them as shown: the
// returned Date carries that wall-clock time as if it were UTC (read it back with the getUTC* methods or
// toISOString). A tier is decided by the date, so the missing zone does not matter there. A date with no time
// gets 12:00 so no zone shift can move it to another day.
//
// The wording below is written from how such pages are usually phrased, not from captured pages, so the parser
// is deliberately strict about "delivered": a bare "Delivered" with no date is often just a step label in a
// progress bar, so it counts as unknown rather than as a delivery. Whenever the text does not clearly give a
// date (relative words like "today", an impossible day, a date in the future) the answer is "no date", never a
// guess. Numeric dates are read month first, as US pages write them.

/**
 * Words that show a tracking page has finished rendering and says something about the shipment. The tracker
 * sends this list to the browser extension with each TRACK_CARRIER command, so both sides use one definition.
 */
export const CARRIER_STATUS_WORDS: readonly string[] = [
  'delivered', 'in transit', 'out for delivery', 'on the way', 'exception', 'delivery exception',
  'label created', 'shipment created', 'pending', 'delayed', 'picked up', 'arriving',
];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const STATUS_WORD_RE = new RegExp(`\\b(?:${CARRIER_STATUS_WORDS.map(escapeRe).join('|')})\\b`, 'i');

/** True when the page text contains at least one status word. */
export function hasCarrierStatusWord(text: string): boolean {
  return STATUS_WORD_RE.test(String(text ?? ''));
}

export type CarrierPageStatus = 'delivered' | 'in_transit' | 'exception' | 'unknown';
export type CarrierPageResult = { status: CarrierPageStatus; deliveredAt?: Date };

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH_RE = '(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?';
const monthNo = (s: string) => MONTHS.indexOf(s.slice(0, 3).toLowerCase()) + 1;

type Ymd = { year: number | null; month: number; day: number; end: number; at: number };

// The first date in the text, in whichever of the usual formats comes first.
function findDate(s: string): Ymd | null {
  const found: Ymd[] = [];
  let m = s.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (m) found.push({ year: +m[1], month: +m[2], day: +m[3], at: m.index!, end: m.index! + m[0].length });
  // Numeric dates are read month first, as US pages write them.
  m = s.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})\b/);
  if (m) found.push({ year: m[3].length === 2 ? 2000 + +m[3] : +m[3], month: +m[1], day: +m[2], at: m.index!, end: m.index! + m[0].length });
  m = s.match(new RegExp(`\\b${MONTH_RE}\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`, 'i'));
  if (m) found.push({ year: m[3] ? +m[3] : null, month: monthNo(m[1]), day: +m[2], at: m.index!, end: m.index! + m[0].length });
  m = s.match(new RegExp(`\\b(\\d{1,2})\\s+${MONTH_RE},?\\s+(\\d{4})\\b`, 'i'));
  if (m) found.push({ year: +m[3], month: monthNo(m[2]), day: +m[1], at: m.index!, end: m.index! + m[0].length });
  // "11/23" with no year, not the tail of a longer numeric date.
  m = s.match(/(?<![\d/])(\d{1,2})\/(\d{1,2})(?![\d/])/);
  if (m) found.push({ year: null, month: +m[1], day: +m[2], at: m.index!, end: m.index! + m[0].length });
  if (!found.length) return null;
  return found.sort((a, b) => a.at - b.at)[0];
}

// A time of day after the date: "2:15 PM", "1:07 P.M." or 24-hour "14:15".
function findTime(s: string): { h: number; min: number } | null {
  const ap = s.match(/\b(\d{1,2}):(\d{2})\s*([ap])\.?\s*m\b/i);
  if (ap && +ap[1] >= 1 && +ap[1] <= 12) {
    return { h: (+ap[1] % 12) + (ap[3].toLowerCase() === 'p' ? 12 : 0), min: +ap[2] };
  }
  const h24 = s.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  return h24 ? { h: +h24[1], min: +h24[2] } : null;
}

function toWallClock(s: string, now: Date): Date | null {
  const d = findDate(s);
  if (!d) return null;
  const t = findTime(s.slice(d.end, d.end + 60));
  const make = (year: number) => new Date(Date.UTC(year, d.month - 1, d.day, t ? t.h : 12, t ? t.min : 0));
  let out = make(d.year ?? now.getUTCFullYear());
  // A page without a year means the recent past: never a date well after today.
  if (d.year === null && out.getTime() > now.getTime() + 2 * 86_400_000) out = make(now.getUTCFullYear() - 1);
  if (out.getUTCMonth() !== d.month - 1 || out.getUTCDate() !== d.day) return null;
  // A delivery cannot be in the future (two days of slack for the missing zone), so a date that far ahead was
  // misread. A year before 2000 is a misread too.
  if (out.getTime() > now.getTime() + 2 * 86_400_000 || out.getUTCFullYear() < 2000) return null;
  return out;
}

// Lines that mention "delivered" without saying it happened.
const NOT_YET = /\b(not|un)\s?delivered|will be delivered|to be delivered|be delivered|estimated|expected|scheduled|deliver(?:ed|y)? by|if delivered/i;
// A line after "Delivered" that belongs to something else, so its date is not the delivery date.
const OTHER_EVENT = /estimated|expected|scheduled|ship date|order|label created|out for delivery|picked up/i;

function deliveredAtFrom(lines: string[], now: Date): Date | null {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const at = line.search(/\bdelivered\b/i);
    if (at < 0 || NOT_YET.test(line)) continue;
    let tail = line.slice(at);
    for (let k = 1; k <= 3; k++) {
      const hit = toWallClock(tail, now);
      if (hit) return hit;
      const next = lines[i + k];
      if (next === undefined || OTHER_EVENT.test(next)) break;
      tail += ' ' + next;
    }
  }
  return null;
}

const EXCEPTION = /delivery exception|shipment exception|unable to deliver|delivery attempted|attempted delivery|delivery attempt|held at|return(?:ed)? to sender|address (?:issue|correction)|exception/i;
const IN_TRANSIT = /in transit|on the way|out for delivery|on fedex vehicle|on vehicle for delivery|picked up|shipped|label created|shipment information received|departed|arrived at|at (?:the )?(?:local |fedex |ups )?facility|origin scan|destination scan/i;

export function parseCarrierPage(text: string, now: Date = new Date()): CarrierPageResult {
  const lines = String(text ?? '').split(/\r?\n/).map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const deliveredAt = deliveredAtFrom(lines, now);
  if (deliveredAt) return { status: 'delivered', deliveredAt };
  const all = lines.join('\n');
  if (EXCEPTION.test(all)) return { status: 'exception' };
  if (IN_TRANSIT.test(all)) return { status: 'in_transit' };
  return { status: 'unknown' };
}
