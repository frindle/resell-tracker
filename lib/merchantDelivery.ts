// Amazon and Walmart tell us themselves when their own deliveries arrived (an order page's status line, a
// Walmart order page, a "delivered" email). FedEx and UPS numbers are NOT taken from them: those go to the
// carrier's own page (lib/carrierPage.ts). This file decides what to write; lib/merchantDeliveryDb.ts writes it.
import { parseCarrierPage } from './carrierPage.ts';
import { detectCarrierForOrder } from './carrierDetect.ts';
import { laDay } from './books/dates.ts';

export type MerchantSource = 'amazon' | 'walmart';

/** Which merchant's own data may speak for this tracking number; null when it belongs to a carrier's page. */
export function merchantSourceFor(
  order: { platform?: string | null; orderNumber?: string | null },
  trackingNumber: string,
  carrierName?: string | null,
): MerchantSource | null {
  const c = detectCarrierForOrder(trackingNumber, carrierName, order);
  if (c === 'amazon' || c === 'walmart') return c;
  // A number no carrier format claims (the merchant's own reference) belongs to the merchant of the order. So
  // does a USPS number: the tracker has no USPS lookup, so the merchant's own word is the only one it gets.
  if (c === 'unknown' || c === 'usps') {
    const p = String(order.platform ?? '').trim().toLowerCase();
    if (p === 'amazon' || p === 'walmart') return p;
  }
  return null;
}

export type ExistingDelivery = { source: string; deliveredAt: Date | null } | null;
export type DeliveryDecision = { action: 'create' | 'update' | 'skip'; deliveredAt?: Date };

const SLACK_MS = 2 * 86_400_000;

/** True when `d` falls on a calendar day before the order's day (carrier times are wall-clock stored as UTC). */
export function beforeOrder(d: Date, orderDate?: Date | null): boolean {
  if (!orderDate || !Number.isFinite(orderDate.getTime())) return false;
  // `d` is wall clock stored as UTC, so its UTC day is its own day; the order is a real instant, so take its Los Angeles day.
  return d.toISOString().slice(0, 10) < laDay(orderDate);
}

/**
 * Whether to write a merchant's delivered date over what the tracker already has for the number.
 * - A row from the carrier's own page is never overwritten.
 * - An existing delivered date is never moved later; an earlier one replaces it.
 * - A date in the future (beyond a little slack) or an invalid one is not written.
 */
export function decideMerchantDelivery(existing: ExistingDelivery, deliveredAt: Date, now: Date, orderDate?: Date | null): DeliveryDecision {
  const t = deliveredAt?.getTime();
  if (!Number.isFinite(t) || t > now.getTime() + SLACK_MS) return { action: 'skip' };
  if (beforeOrder(deliveredAt, orderDate)) return { action: 'skip' };
  if (!existing) return { action: 'create', deliveredAt };
  // A carrier-page row with no delivered date yet (a queued lookup) does not block the merchant's date.
  if (existing.source === 'carrier-page' && existing.deliveredAt) return { action: 'skip' };
  // A stored date from before the order was placed (or in the future) was misread: the new date replaces it.
  const bad = !!existing.deliveredAt && (beforeOrder(existing.deliveredAt, orderDate) || existing.deliveredAt.getTime() > now.getTime() + SLACK_MS);
  if (!bad && existing.deliveredAt && existing.deliveredAt.getTime() <= t) return { action: 'skip' };
  return { action: 'update', deliveredAt };
}

/**
 * An email's own date as the delivery time. The tracker keeps delivery times as local wall-clock time stored as
 * if UTC (lib/carrierPage.ts); an email carries a real instant and not the delivery place, so it is shown in
 * Pacific time, the zone BG's deadlines are written in. Null when the date is missing or invalid.
 */
export function wallClockFromEmailDate(date: string | Date | null | undefined): Date | null {
  if (date == null || date === '') return null;
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(d);
  const n = (type: string) => Number(parts.find(p => p.type === type)?.value);
  return new Date(Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute')));
}

// "Delivered today, 3:42pm" / "Delivered yesterday". A carrier page with no zone cannot be trusted with these
// (lib/carrierPage.ts refuses them), but a merchant's order page is read by our own browser the moment it is
// imported, in the account's zone, so "today" is the Pacific day of `now`.
const RELATIVE_DELIVERED = /\bdelivered\b[^\n]*?\b(today|yesterday)\b|\b(today|yesterday)\b[^\n]*?\bdelivered\b/i;
const NOT_DELIVERED_YET = /\b(not|un)\s?delivered|will be delivered|to be delivered|estimated|expected|scheduled|arriv(?:es|ing|al)|deliver(?:ed|y)? by/i;

/** The delivered time a merchant page gives only as "today" or "yesterday", as Pacific wall clock; else null. */
export function relativeDeliveredAt(text: string, now: Date): Date | null {
  const today = wallClockFromEmailDate(now);
  if (!today) return null;
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.replace(/\s+/g, ' ').trim();
    const m = line.match(RELATIVE_DELIVERED);
    if (!m || NOT_DELIVERED_YET.test(line)) continue;
    const back = (m[1] ?? m[2]).toLowerCase() === 'yesterday' ? 1 : 0;
    const t = line.match(/\b(\d{1,2}):(\d{2})\s*([ap])\.?\s*m\b/i);
    const h = t && +t[1] >= 1 && +t[1] <= 12 ? (+t[1] % 12) + (t[3].toLowerCase() === 'p' ? 12 : 0) : 12;
    const min = t && +t[1] >= 1 && +t[1] <= 12 ? +t[2] : 0;
    const out = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - back, h, min));
    // No time given: noon, or now when "today" is read before noon.
    if (!t) return out.getTime() > today.getTime() ? today : out;
    // "Today, 11:50pm" read at 9pm is a misread, not a delivery: never later than now.
    return out.getTime() > today.getTime() + 60_000 ? null : out;
  }
  return null;
}

/**
 * The delivered time to record for one order: the date the page gave (the text near its "Delivered" line)
 * when there is one, otherwise a delivered email's own date, otherwise the page's "today" or "yesterday"
 * dated from now (the page is read live, so now is when it was read). Null when none gives one.
 */
export function merchantDeliveredAt(input: { pageText?: string | null; emailDate?: string | Date | null; now: Date; orderDate?: Date | null }): Date | null {
  const text = String(input.pageText ?? '');
  if (text) {
    const r = parseCarrierPage(text, input.now, input.orderDate);
    if (r.status === 'delivered' && r.deliveredAt) return r.deliveredAt;
  }
  const email = wallClockFromEmailDate(input.emailDate);
  if (email && !beforeOrder(email, input.orderDate)) return email;
  const rel = text ? relativeDeliveredAt(text, input.now) : null;
  return rel && !beforeOrder(rel, input.orderDate) ? rel : null;
}

/**
 * Which tracking numbers a delivered signal speaks for. A page's date covers the numbers the import row has.
 * A delivered email covers the numbers it carried; with none, it can only speak for an order that has exactly one
 * number, because with several shipments the email may be about any of them.
 */
export function deliveredNumbers(input: { hasPageText: boolean; emailNumbers?: readonly string[]; rowNumbers: readonly string[]; storedNumbers: readonly string[] }): string[] {
  const clean = (l: readonly string[] | undefined) => [...new Set((l ?? []).map(s => String(s ?? '').trim()).filter(Boolean))];
  const email = clean(input.emailNumbers);
  const row = clean(input.rowNumbers);
  const stored = clean(input.storedNumbers);
  if (input.hasPageText) return row.length ? row : stored.length === 1 ? stored : [];
  if (email.length) return email;
  const all = clean([...row, ...stored]);
  return all.length === 1 ? all : [];
}

/** The earlier of two ship dates; an invalid or missing one never wins. */
export function earlierShipDate(a: Date | null | undefined, b: Date | null | undefined): Date | null {
  const ok = (d: Date | null | undefined): d is Date => !!d && Number.isFinite(d.getTime());
  if (ok(a) && ok(b)) return a.getTime() <= b.getTime() ? a : b;
  return ok(a) ? a : ok(b) ? b : null;
}
