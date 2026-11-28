// Which tracking numbers the extension should look up on the FedEx / UPS public pages next (group-bound orders only). Pure: the caller
// loads the candidates and the CarrierDelivery rows and hands them in.
//
// The extension runs TRACK_CARRIER commands (payload { userId, items }) and, like the Amazon ones, only the
// real browser extension can run them, so they are always targeted at it.
import { AMAZON_EXTENSION_TARGET } from './amazonSync.ts';

export const TRACK_CARRIER = 'TRACK_CARRIER';
export const CARRIER_EXTENSION_TARGET = AMAZON_EXTENSION_TARGET;

export const CARRIER_RECHECK_MS = 6 * 60 * 60 * 1000;
export const CARRIER_MAX_ATTEMPTS = 8;
export const CARRIER_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
export const CARRIER_MAX_PER_RUN = 5;
export const CARRIER_MAX_PER_DAY = 20;

export type CarrierItem = { carrier: 'fedex' | 'ups'; trackingNumber: string };
/** statusWords: the page words that mean a tracking result has rendered (lib/carrierPage.ts), so the extension and the parser agree. */
export type CarrierCommandPayload = { userId: number; items: CarrierItem[]; statusWords: readonly string[] };

/** How far back from now an order is looked at for a ship date inside the window (a late shipment of an old order still counts). */
export const CARRIER_ORDER_SCAN_MS = 90 * 24 * 60 * 60 * 1000;

/** The ship date for the 14-day window: the shipping email's date when known, else the order date. */
export function shipDateFor(emailShippedAt: Date | null | undefined, orderDate: Date | null | undefined): Date | null {
  const ok = (d: Date | null | undefined): d is Date => !!d && Number.isFinite(d.getTime());
  return ok(emailShippedAt) ? emailShippedAt : ok(orderDate) ? orderDate : null;
}

/** Numbers handed to the extension, counted from the payloads of the TRACK_CARRIER commands created in the last 24 hours. */
export function countQueuedItems(payloads: readonly (string | null)[]): number {
  let n = 0;
  for (const raw of payloads) {
    try {
      const items = (JSON.parse(raw ?? 'null') as { items?: unknown } | null)?.items;
      if (Array.isArray(items)) n += items.length;
    } catch { /* an unreadable payload counts as nothing */ }
  }
  return n;
}

export type CarrierCandidate = {
  carrier: string;
  trackingNumber: string;
  /** When the package shipped (see shipDateFor); null when unknown. */
  shippedAt: Date | null;
  /** The order is bound for a buying group: linked to a BuyingGroup commitment, a BFMR reservation or a BigSky commitment, or assigned to one of them. */
  groupBound: boolean;
};

export type CarrierRowState = {
  trackingNumber: string;
  status: string;
  deliveredAt: Date | null;
  checkedAt: Date | null;
  attempts: number;
};

export type CarrierPlanInput = {
  candidates: readonly CarrierCandidate[];
  rows: readonly CarrierRowState[];
  /** Lookups handed to the extension in the last 24 hours, rechecks included (see countQueuedItems). */
  sentLast24h: number;
  now: Date;
};

const key = (s: string) => String(s ?? '').trim().replace(/\s+/g, '').toUpperCase();

export function planCarrierChecks(input: CarrierPlanInput): CarrierItem[] {
  const { candidates, rows, sentLast24h, now } = input;
  const room = Math.min(CARRIER_MAX_PER_RUN, CARRIER_MAX_PER_DAY - sentLast24h);
  if (room <= 0) return [];
  const byNumber = new Map(rows.map(r => [key(r.trackingNumber), r]));
  const seen = new Set<string>();
  const due: { item: CarrierItem; checkedAt: number }[] = [];
  for (const c of candidates) {
    if (!c.groupBound || (c.carrier !== 'fedex' && c.carrier !== 'ups')) continue;
    const k = key(c.trackingNumber);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    // No ship date means the 14-day window cannot be shown, so leave it alone.
    if (!c.shippedAt || now.getTime() - c.shippedAt.getTime() > CARRIER_WINDOW_MS) continue;
    const row = byNumber.get(k);
    if (row) {
      if (row.status === 'delivered' || row.deliveredAt) continue;
      if (row.attempts >= CARRIER_MAX_ATTEMPTS) continue;
      if (row.checkedAt && now.getTime() - row.checkedAt.getTime() < CARRIER_RECHECK_MS) continue;
    }
    due.push({ item: { carrier: c.carrier, trackingNumber: c.trackingNumber.trim() }, checkedAt: row?.checkedAt?.getTime() ?? 0 });
  }
  // Never-checked numbers first, then the one checked longest ago.
  due.sort((a, b) => a.checkedAt - b.checkedAt);
  return due.slice(0, room).map(d => d.item);
}
