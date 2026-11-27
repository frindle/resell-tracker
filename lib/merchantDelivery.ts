// Amazon and Walmart tell us themselves when their own deliveries arrived (an order page's status line, a
// Walmart order page, a "delivered" email). FedEx and UPS numbers are NOT taken from them: those go to the
// carrier's own page (lib/carrierPage.ts). This file decides what to write; lib/merchantDeliveryDb.ts writes it.
import { parseCarrierPage } from './carrierPage.ts';
import { detectCarrierForOrder } from './carrierDetect.ts';

export type MerchantSource = 'amazon' | 'walmart';

/** Which merchant's own data may speak for this tracking number; null when it belongs to a carrier's page. */
export function merchantSourceFor(
  order: { platform?: string | null; orderNumber?: string | null },
  trackingNumber: string,
  carrierName?: string | null,
): MerchantSource | null {
  const c = detectCarrierForOrder(trackingNumber, carrierName, order);
  if (c === 'amazon' || c === 'walmart') return c;
  // A number no carrier format claims (the merchant's own reference) belongs to the merchant of the order.
  if (c === 'unknown') {
    const p = String(order.platform ?? '').trim().toLowerCase();
    if (p === 'amazon' || p === 'walmart') return p;
  }
  return null;
}

export type ExistingDelivery = { source: string; deliveredAt: Date | null } | null;
export type DeliveryDecision = { action: 'create' | 'update' | 'skip'; deliveredAt?: Date };

const SLACK_MS = 2 * 86_400_000;

/**
 * Whether to write a merchant's delivered date over what the tracker already has for the number.
 * - A row from the carrier's own page is never overwritten.
 * - An existing delivered date is never moved later; an earlier one replaces it.
 * - A date in the future (beyond a little slack) or an invalid one is not written.
 */
export function decideMerchantDelivery(existing: ExistingDelivery, deliveredAt: Date, now: Date): DeliveryDecision {
  const t = deliveredAt?.getTime();
  if (!Number.isFinite(t) || t > now.getTime() + SLACK_MS) return { action: 'skip' };
  if (!existing) return { action: 'create', deliveredAt };
  if (existing.source === 'carrier-page') return { action: 'skip' };
  if (existing.deliveredAt && existing.deliveredAt.getTime() <= t) return { action: 'skip' };
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

/**
 * The delivered time to record for one order: the date the page gave (the text near its "Delivered" line)
 * when there is one, otherwise a delivered email's own date. Null when neither gives one.
 */
export function merchantDeliveredAt(input: { pageText?: string | null; emailDate?: string | Date | null; now: Date }): Date | null {
  const text = String(input.pageText ?? '');
  if (text) {
    const r = parseCarrierPage(text, input.now);
    if (r.status === 'delivered' && r.deliveredAt) return r.deliveredAt;
  }
  return wallClockFromEmailDate(input.emailDate);
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
