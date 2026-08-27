// `Order.orderDate` is a DateTime column. Manually-entered orders go through
// a real `datetime-local` input (see OrderForm.tsx) and always carry a
// genuine local time. Bulk-imported orders can carry a bare "YYYY-MM-DD"
// source date with no time at all, which `new Date(...)` parses as UTC
// midnight -- and neither a UTC-based nor a local-based check on the
// resulting Date object can reliably tell that apart from a genuine local
// midnight without shifting some case to the wrong calendar day (timezone
// math is inherently ambiguous once you're back to just a Date object).
// So detection happens on the RAW STRING before any parsing/timezone
// conversion: a literal "T00:00:00" (a synthetic stamp, ignoring optional
// milliseconds/zone suffix) means no real time was ever supplied.
//
// EVERY surface that shows or keys off an order's calendar day must go
// through this module. The bug it exists to prevent: a date-only order
// stored as 2026-06-19T00:00:00.000Z reads back as 2026-06-18 17:00 through
// local getters, so a list rendered with the UTC branch said 6/19 while the
// edit form (which used local getters directly) said 6/18 5:00 pm for the
// same order. Same value, two different days, depending on which helper the
// screen happened to use.
//
// Known, deliberate ambiguity: an order genuinely placed at a local time
// that lands exactly on UTC midnight (5:00 pm PDT) is indistinguishable
// from an imported date-only value at this layer, and is treated as
// date-only. The calendar day shown is still the UTC day the row holds; only
// the (never-supplied-anyway) time is dropped. Fixing that properly needs a
// separate "date precision" column on the row, not more timezone guessing.
const SYNTHETIC_MIDNIGHT = /T00:00:00(\.0+)?Z?$/;

/** True when the stored value carries no real clock time, only a calendar day. */
export function isDateOnlyOrderDate(value: string | Date): boolean {
  const raw = typeof value === 'string' ? value : value.toISOString();
  return SYNTHETIC_MIDNIGHT.test(raw);
}

type Parts = { year: number; month: number; day: number; hours: number; minutes: number; dateOnly: boolean; date: Date };

/**
 * Calendar fields for an order date, read through the getters that match how
 * the value was stored: UTC for a date-only value (so the imported calendar
 * day comes back exactly), local for a real timestamp (so the user sees the
 * time they actually placed the order).
 */
function parts(value: string | Date): Parts | null {
  const d = typeof value === 'string' ? new Date(value) : value;
  if (isNaN(d.getTime())) return null;
  if (isDateOnlyOrderDate(value)) {
    return {
      year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(),
      hours: 0, minutes: 0, dateOnly: true, date: d,
    };
  }
  return {
    year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate(),
    hours: d.getHours(), minutes: d.getMinutes(), dateOnly: false, date: d,
  };
}

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * Display form: always MM/DD/YYYY, with the time appended only when the row
 * actually has one and the caller wants it. The date part is deliberately the
 * same shape for date-only and timestamped orders -- the Date column used to
 * render "2026-06-19" for one and "06/20/2026" for the other, in the same
 * column, which is what "dates are displayed differently" looked like.
 */
export function formatOrderDate(value: string | Date, opts?: { dateOnly?: boolean }): string {
  const p = parts(value);
  if (!p) return typeof value === 'string' ? value : '';
  const datePart = `${pad(p.month)}/${pad(p.day)}/${p.year}`;
  if (p.dateOnly || opts?.dateOnly) return datePart;
  const timePart = p.date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }).toLowerCase();
  return `${datePart} ${timePart}`;
}

/**
 * Sortable/machine form: YYYY-MM-DD. Use for CSV columns and for grouping
 * keys, so a group header and the rows under it can't land on different days.
 */
export function formatOrderDateIso(value: string | Date): string {
  const p = parts(value);
  if (!p) return typeof value === 'string' ? value : '';
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/**
 * Value for an `<input type="datetime-local">`: "YYYY-MM-DDTHH:mm".
 * A date-only row comes back as midnight on its own calendar day rather than
 * as the previous evening in the viewer's timezone.
 */
export function toOrderDateInputValue(value: string | Date): string {
  const p = parts(value);
  if (!p) return '';
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hours)}:${pad(p.minutes)}`;
}

/**
 * Inverse of `toOrderDateInputValue`, for the save path. A datetime-local
 * string carries no offset, so `new Date(v)` reads it as local time and
 * `toISOString()` serializes the user's real instant (a Costco order made at
 * 10:30 am PDT was landing as 03:30 am when the raw string reached a server
 * that parsed it as UTC).
 *
 * Midnight is the exception: it round-trips back to UTC midnight so a
 * date-only row that the user opened and saved without touching the date
 * stays date-only instead of silently acquiring a 07:00Z timestamp and
 * shifting how every other screen reads it. A bare "YYYY-MM-DD" (the
 * delivery-deadline input) takes the same path.
 */
export function fromOrderDateInputValue(value: string): string {
  if (!value) return value;
  const m = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}):(\d{2}))?/.exec(value);
  if (m && (m[2] === undefined || (m[2] === '00' && m[3] === '00'))) return `${m[1]}T00:00:00.000Z`;
  const d = new Date(value);
  return isNaN(d.getTime()) ? value : d.toISOString();
}
