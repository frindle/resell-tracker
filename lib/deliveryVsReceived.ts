// Two separate facts per order: did the CARRIER deliver the package, and has the buying group RECEIVED it.
// Pure: lib/deliveryVsReceivedDb.ts loads the inputs. A late receipt is the useful signal: the carrier says
// delivered, the group has not counted it yet.
//
import { expectedDisplay, type ExpectedDelivery } from './expectedDelivery.ts';

// Carrier dates are local wall-clock time stored as if UTC (see CarrierDelivery in prisma/schema.prisma), so
// only the calendar day is shown and day counts use the stored value as is.

/** Delivered this many days ago or more, with no receipt from the group, raises the flag. One place to tune it. */
export const LATE_RECEIPT_DAYS = 3;

export type DeliveryRow = {
  trackingNumber: string;
  carrier: string;
  status: string;
  deliveredAt: Date | null;
  source: string;
};

export type Delivered =
  | { state: 'delivered'; at: Date; carrier: string; source: string; count: number }
  | { state: 'partial'; delivered: number; total: number; at: Date; carrier: string; source: string }
  | { state: 'in_transit' }
  | { state: 'exception' }
  | { state: 'unknown' };

/** What the group side says. state 'unknown' when the group exposes nothing usable for the order. */
export type GroupReceipt =
  | { state: 'received'; group: string; at: Date | null }
  | { state: 'not_yet'; group: string }
  | { state: 'unknown'; group?: string };

export type DeliveryVsReceived = {
  delivered: Delivered;
  received: GroupReceipt;
  /** Whole days since the last carrier delivery; null unless every package is delivered. */
  daysSinceDelivered: number | null;
  /** Every package delivered at least LATE_RECEIPT_DAYS ago and the group has not received it. */
  lateReceipt: boolean;
};

export const trackingKey = (s: string) => String(s ?? '').trim().replace(/\s+/g, '').toUpperCase();

const DAY_MS = 24 * 60 * 60 * 1000;

function plausibleDelivery(at: Date, opts: { now?: Date; orderDate?: Date | null }): boolean {
  if (opts.now && at.getTime() > opts.now.getTime() + FUTURE_SLACK_MS) return false;
  const od = opts.orderDate;
  if (od && Number.isFinite(od.getTime()) && at.getTime() < Date.UTC(od.getUTCFullYear(), od.getUTCMonth(), od.getUTCDate())) return false;
  return true;
}

/**
 * Slack for the missing zone on a wall-clock delivery time. A delivered date more than this after `now`, or on a
 * day before the order, was misread (an estimate or a wrong year) and does not count as delivered.
 */
const FUTURE_SLACK_MS = 2 * DAY_MS;

export function summarizeDelivery(numbers: readonly string[], rows: readonly DeliveryRow[], opts: { now?: Date; orderDate?: Date | null } = {}): Delivered {
  const keys = [...new Set(numbers.map(trackingKey).filter(Boolean))];
  if (!keys.length) return { state: 'unknown' };
  const byKey = new Map(rows.map(r => [trackingKey(r.trackingNumber), r]));
  const delivered: DeliveryRow[] = [];
  let transit = false, exception = false;
  for (const k of keys) {
    const r = byKey.get(k);
    if (!r) continue;
    // A stored delivered date wins over a stale status word.
    if (r.deliveredAt && plausibleDelivery(r.deliveredAt, opts)) delivered.push(r);
    else if (r.deliveredAt) continue;
    else if (r.status === 'in_transit') transit = true;
    else if (r.status === 'exception') exception = true;
  }
  if (delivered.length) {
    const last = delivered.reduce((a, b) => ((b.deliveredAt as Date) > (a.deliveredAt as Date) ? b : a));
    const base = { at: last.deliveredAt as Date, carrier: last.carrier, source: last.source };
    return delivered.length === keys.length
      ? { state: 'delivered', count: keys.length, ...base }
      : { state: 'partial', delivered: delivered.length, total: keys.length, ...base };
  }
  if (exception) return { state: 'exception' };
  if (transit) return { state: 'in_transit' };
  return { state: 'unknown' };
}

export function deliveryVsReceived(input: {
  trackingNumbers: readonly string[];
  rows: readonly DeliveryRow[];
  received: GroupReceipt;
  now: Date;
  orderDate?: Date | null;
}): DeliveryVsReceived {
  const delivered = summarizeDelivery(input.trackingNumbers, input.rows, { now: input.now, orderDate: input.orderDate });
  const daysSinceDelivered = delivered.state === 'delivered'
    ? Math.max(0, Math.floor((input.now.getTime() - delivered.at.getTime()) / DAY_MS))
    : null;
  const lateReceipt = daysSinceDelivered != null && daysSinceDelivered >= LATE_RECEIPT_DAYS && input.received.state === 'not_yet';
  return { delivered, received: input.received, daysSinceDelivered, lateReceipt };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "Nov 25": the calendar day of a date stored as UTC. */
export const dayLabel = (d: Date) => `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;

const CARRIER_NAMES: Record<string, string> = { fedex: 'FedEx', ups: 'UPS', usps: 'USPS', amazon: 'Amazon', walmart: 'Walmart' };
const carrierName = (c: string) => CARRIER_NAMES[c.toLowerCase()] ?? c;

/** "Delivered Nov 25 (UPS)", "1 of 2 delivered", "In transit", ... */
export function deliveredLabel(d: Delivered): string {
  switch (d.state) {
    case 'delivered': return `Delivered ${dayLabel(d.at)} (${carrierName(d.carrier)})`;
    case 'partial': return `${d.delivered} of ${d.total} delivered`;
    case 'in_transit': return 'In transit';
    case 'exception': return 'Delivery problem';
    default: return 'Delivery unknown';
  }
}

/** "Received by BG Nov 26", "Not received by BFMR yet (3 days)", "Group receipt unknown". */
/** Null when the order is not bound for any group: there is no receipt to show, only the carrier side. */
export function receivedLabel(v: DeliveryVsReceived): string | null {
  const r = v.received;
  if (r.state === 'received') return `Received by ${r.group}${r.at ? ` ${dayLabel(r.at)}` : ''}`;
  if (r.state === 'not_yet') {
    // Only when the carrier or merchant says it was delivered. In transit, pending, no tracking or an unknown
    // delivery obviously has not been received, so there is nothing to act on.
    if (v.delivered.state !== 'delivered') return null;
    const days = v.daysSinceDelivered;
    return `Not received by ${r.group} yet${days != null && days >= 1 ? ` (${days} ${days === 1 ? 'day' : 'days'})` : ''}`;
  }
  return r.group ? `${r.group} receipt unknown` : null;
}

/** "Not received by BG yet" is the one worth acting on: delivered, and the group has not counted it. */
export const showNotReceived = (v: DeliveryVsReceived) => v.received.state === 'not_yet' && v.delivered.state === 'delivered';

/** "11/27": the calendar day of a date stored as UTC, for tight spaces. */
export const shortDay = (d: Date) => `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;

/** Short forms for a table cell: "Delivered 11/27", "1/2 delivered", "In transit", ... */
export function deliveredShort(d: Delivered): string {
  switch (d.state) {
    case 'delivered': return `Delivered ${shortDay(d.at)}`;
    case 'partial': return `${d.delivered}/${d.total} delivered`;
    case 'in_transit': return 'In transit';
    case 'exception': return 'Delivery problem';
    default: return 'Delivery unknown';
  }
}

/** "Received 11/26", "Not received (3d)", "Receipt unknown"; null when receivedLabel is. */
export function receivedShort(v: DeliveryVsReceived): string | null {
  if (receivedLabel(v) == null) return null;
  const r = v.received;
  if (r.state === 'received') return `Received${r.at ? ` ${shortDay(r.at)}` : ''}`;
  if (r.state === 'not_yet') {
    const days = v.daysSinceDelivered;
    return `Not received${days != null && days >= 1 ? ` (${days}d)` : ''}`;
  }
  return 'Receipt unknown';
}

/** The two facts on one line (just the carrier one for an order no group is waiting on). Nothing known returns null. */
export function deliveryLine(v: DeliveryVsReceived): string | null {
  if (v.delivered.state === 'unknown' && v.received.state === 'unknown') return null;
  const received = receivedLabel(v);
  return received ? `${deliveredLabel(v.delivered)} · ${received}` : deliveredLabel(v.delivered);
}

/** The plain, JSON-safe form the pages get: one label per fact and the late flag. Null when nothing is known. */
export type DeliveryDisplay = {
  delivered: string;
  /** Null for an order not bound for a group, or one not delivered yet and not received. */
  received: string | null;
  /** Short forms for a table cell (the long ones go in a tooltip). */
  deliveredShort: string;
  receivedShort: string | null;
  /** The carrier delivered every package; styles the first label. */
  deliveredOk: boolean;
  /** The group has the order; styles the second label. */
  receivedOk: boolean;
  late: boolean;
  /**
   * The merchant's expected delivery, standing in for a carrier status we do not have: `delivered` and
   * `deliveredShort` already say it. `late` is the expected day passing undelivered (amber); `tooltip` names the source.
   */
  expected?: { late: boolean; tooltip: string };
};

/** The expected delivery an order carries, or null for a cancelled order or one with none. */
export function expectedOf(o: {
  cancelled?: boolean | null;
  expectedDeliveryStart?: Date | string | null;
  expectedDeliveryEnd?: Date | string | null;
  expectedDeliverySource?: string | null;
  expectedDeliverySeenAt?: Date | string | null;
}): ExpectedDelivery | null {
  if (o.cancelled || !o.expectedDeliveryStart || !o.expectedDeliveryEnd) return null;
  const start = new Date(o.expectedDeliveryStart), end = new Date(o.expectedDeliveryEnd);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) return null;
  const seen = o.expectedDeliverySeenAt ? new Date(o.expectedDeliverySeenAt) : null;
  return { start, end, source: o.expectedDeliverySource ?? null, seenAt: seen && Number.isFinite(seen.getTime()) ? seen : null };
}

/**
 * What the carrier and group say, plus the merchant's expected delivery when (and only when) we have no carrier
 * status: any carrier or delivered status, and a group receipt, wins over the expected date.
 */
export function deliveryDisplay(v: DeliveryVsReceived | null | undefined, expected?: ExpectedDelivery | null, now: Date = new Date()): DeliveryDisplay | null {
  const base = deliveryDisplayOf(v);
  if (!expected || (v && (v.delivered.state !== 'unknown' || v.received.state === 'received'))) return base;
  const e = expectedDisplay(expected, now);
  return {
    delivered: e.text, received: base?.received ?? null, deliveredShort: e.text, receivedShort: base?.receivedShort ?? null,
    deliveredOk: false, receivedOk: false, late: false,
    expected: { late: e.late, tooltip: e.tooltip },
  };
}

function deliveryDisplayOf(v: DeliveryVsReceived | null | undefined): DeliveryDisplay | null {
  if (!v || deliveryLine(v) == null) return null;
  return {
    delivered: deliveredLabel(v.delivered),
    received: receivedLabel(v),
    deliveredShort: deliveredShort(v.delivered),
    receivedShort: receivedShort(v),
    deliveredOk: v.delivered.state === 'delivered',
    receivedOk: v.received.state === 'received',
    late: v.lateReceipt,
  };
}

export type GroupName ='BG' | 'BFMR' | 'BigSky';

/** Which group an order is for: the assigned buyer's name first, else the links the order carries. */
export function groupFor(o: { buyerName?: string | null; hasBgLink?: boolean; hasBfmrLink?: boolean; hasBigSkyLink?: boolean }): GroupName | null {
  const b = o.buyerName ?? '';
  if (/bfmr/i.test(b)) return 'BFMR';
  if (/buying\s*group/i.test(b)) return 'BG';
  if (/big\s*sky/i.test(b)) return 'BigSky';
  if (o.hasBfmrLink) return 'BFMR';
  if (o.hasBgLink) return 'BG';
  if (o.hasBigSkyLink) return 'BigSky';
  return null;
}

const BFMR_RECEIVED = new Set(['received', 'pkg_received', 'pkg received', 'processed', 'paid']);
export const bfmrStatusReceived = (s: string | null | undefined) => BFMR_RECEIVED.has(String(s ?? '').trim().toLowerCase());

/**
 * What the group says about receiving the order.
 * BFMR: only a flag and a status, no received date.
 * BG: commitment-level counts; fully filled = received (at the date the sync first saw it filled), none filled =
 *   not yet, partly filled = unknown (cannot tell which order's units were counted).
 * BigSky: a scan whose box carries one of the order's tracking numbers = received on the scan's date.
 */
export function groupReceiptFor(
  group: GroupName | null,
  facts: {
    bfmrReceived?: boolean | null;
    bfmrStatus?: string | null;
    reservationStatuses?: readonly string[];
    commitments?: readonly { fulfilled: number; count: number; fulfilledAt: Date | null }[];
    bigSkyScanDates?: readonly (Date | null)[];
  },
): GroupReceipt {
  if (!group) return { state: 'unknown' };
  if (group === 'BFMR') {
    const res = facts.reservationStatuses ?? [];
    const got = !!facts.bfmrReceived || bfmrStatusReceived(facts.bfmrStatus) || (res.length > 0 && res.every(bfmrStatusReceived));
    return got ? { state: 'received', group, at: null } : { state: 'not_yet', group };
  }
  if (group === 'BigSky') {
    const dates = facts.bigSkyScanDates ?? [];
    if (!dates.length) return { state: 'not_yet', group };
    const real = dates.filter((d): d is Date => !!d).sort((a, b) => a.getTime() - b.getTime());
    return { state: 'received', group, at: real[0] ?? null };
  }
  const cs = facts.commitments ?? [];
  if (!cs.length) return { state: 'unknown', group };
  if (cs.every(c => c.count > 0 && c.fulfilled >= c.count)) {
    const times = cs.map(c => c.fulfilledAt).filter((d): d is Date => !!d).map(d => d.getTime());
    return { state: 'received', group, at: times.length ? new Date(Math.max(...times)) : null };
  }
  if (cs.every(c => c.fulfilled === 0)) return { state: 'not_yet', group };
  return { state: 'unknown', group };
}
