// Walmart delivery re-reads. The Walmart sync reads an order page once, soon after the order is placed, so an
// order delivered later never shows as delivered: nothing goes back to look. This plans the per-order page read
// (SYNC_WALMART_ORDER, the sidecar's) for recent Walmart orders the tracker has no delivered date for, at a pace
// a person checking their orders would keep. The read's "Delivered" text goes through the import like any other
// Walmart page (lib/merchantDeliveryDb.ts recordImportSignals). lib/walmartDeliveryRecheckDb.ts is the database side.
import { merchantSourceFor } from './merchantDelivery.ts';

/** Marks the re-read commands in their payload, so they are told apart from gap fills (lib/gapFill.ts). */
export const DELIVERY_RECHECK_PURPOSE = 'delivery';
/** How far back an order may be placed and still be re-read. */
export const RECHECK_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
/** No re-read before the order is this old (it has not shipped yet). */
export const RECHECK_FIRST_AFTER_MS = 12 * 60 * 60 * 1000;
/** Between two re-reads of the same order: the gap after read 1, 2, ... and the last one repeats. They grow so slow packages are still read late. */
export const RECHECK_INTERVALS_MS = [12, 24, 48, 96, 132].map(h => h * 60 * 60 * 1000);
/** Re-reads per order, in all (with the gaps above, the last one is about 13.5 days after the order). */
export const RECHECK_MAX_READS = 6;
/** Orders per command, and orders per day across all commands. */
export const RECHECK_MAX_PER_RUN = 5;
export const RECHECK_MAX_PER_DAY = 25;
/** A new command is planned at most this often. */
export const RECHECK_EVERY_MS = 60 * 60 * 1000;

export const orderDigits = (s: string | null | undefined) => String(s ?? '').replace(/\D/g, '');
const trackingKey = (s: string) => String(s ?? '').trim().replace(/\s+/g, '').toUpperCase();

export type RecheckOrder = {
  orderNumber: string; orderDate: Date | null; trackingNumbers: string | null;
  /** The order already has its delivery photo (only the page read fetches it). */
  hasDeliveryPhoto: boolean;
};
/** One earlier re-read command: when it was made and the orders (digits) it named. */
export type RecheckHistory = { createdAt: Date; orderNumbers: readonly string[] };

/** Order numbers (digits) named by a re-read command's payload; [] for any other command. */
export function recheckOrdersOf(payload: string | null | undefined): string[] {
  try {
    const p = JSON.parse(payload ?? 'null') as { purpose?: unknown; orderNumbers?: unknown } | null;
    if (p?.purpose !== DELIVERY_RECHECK_PURPOSE || !Array.isArray(p.orderNumbers)) return [];
    return p.orderNumbers.map(n => orderDigits(String(n))).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * The orders to re-read now, oldest last read first (never-read first of all). An order qualifies when it was
 * placed inside the window and at least RECHECK_FIRST_AFTER_MS ago, has a tracking number (it shipped), and
 * some number of it has no delivered date yet.
 */
export function planWalmartRechecks(input: {
  orders: readonly RecheckOrder[];
  /** Tracking numbers with a delivered date. */
  deliveredNumbers: ReadonlySet<string>;
  history: readonly RecheckHistory[];
  now: Date;
}): string[] {
  const now = input.now.getTime();
  const reads = new Map<string, { count: number; last: number }>();
  let lastDay = 0;
  for (const h of input.history) {
    const t = h.createdAt.getTime();
    if (now - t < 24 * 60 * 60 * 1000) lastDay += h.orderNumbers.length;
    for (const n of h.orderNumbers) {
      const r = reads.get(n) ?? { count: 0, last: 0 };
      reads.set(n, { count: r.count + 1, last: Math.max(r.last, t) });
    }
  }
  const room = Math.min(RECHECK_MAX_PER_RUN, RECHECK_MAX_PER_DAY - lastDay);
  if (room <= 0) return [];
  const due: { n: string; last: number }[] = [];
  const seen = new Set<string>();
  for (const o of input.orders) {
    const n = orderDigits(o.orderNumber);
    if (!n || seen.has(n)) continue;
    seen.add(n);
    const placed = o.orderDate?.getTime();
    if (placed == null || !Number.isFinite(placed) || now - placed > RECHECK_WINDOW_MS || now - placed < RECHECK_FIRST_AFTER_MS) continue;
    // FedEx and UPS numbers go to the carrier's page, so the Walmart page read does not wait on them.
    const numbers = String(o.trackingNumbers ?? '').split(',').map(trackingKey).filter(Boolean)
      .filter(x => merchantSourceFor({ platform: 'Walmart', orderNumber: o.orderNumber }, x) !== null);
    if (!numbers.length || (numbers.every(x => input.deliveredNumbers.has(x)) && o.hasDeliveryPhoto)) continue;
    const r = reads.get(n) ?? { count: 0, last: 0 };
    if (r.count >= RECHECK_MAX_READS) continue;
    if (r.count > 0 && now - r.last < RECHECK_INTERVALS_MS[Math.min(r.count - 1, RECHECK_INTERVALS_MS.length - 1)]) continue;
    due.push({ n, last: r.last });
  }
  return due.sort((a, b) => a.last - b.last).slice(0, room).map(d => d.n);
}
