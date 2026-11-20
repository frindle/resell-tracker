// Pure helpers for stored OrderPackage rows: merging a fresh capture into what
// is already saved, and the dry-run log entries built from matcher decisions.
// No DB, no I/O.
import type { ParsedPackage, PackageItem } from './amazonPackages.ts';
import type { PackageDecision } from './bfmrPackageMatch.ts';
import { normTracking } from './bfmrLinkGuard.ts';

export interface StoredPackage {
  trackingNumber: string;
  carrier: string | null;
  itemsKnown: boolean;
  items: PackageItem[];
}

/**
 * Fold one freshly captured package into the stored row for the same tracking
 * number. Readable items replace what was there; an unreadable capture never
 * wipes items an earlier capture did read (a tracking page that fails to parse
 * must not erase the detail page's items).
 */
export function mergePackage(existing: StoredPackage | null, incoming: ParsedPackage): StoredPackage {
  const readable = incoming.items !== null && incoming.items.length > 0;
  const base: StoredPackage = {
    trackingNumber: incoming.trackingNumber,
    carrier: incoming.carrier ?? existing?.carrier ?? null,
    itemsKnown: false,
    items: [],
  };
  if (readable) return { ...base, itemsKnown: true, items: incoming.items as PackageItem[] };
  if (existing?.itemsKnown) return { ...base, itemsKnown: true, items: existing.items };
  return base;
}

/** Stable signature of a decision, so an unchanged re-evaluation is not logged again. */
export function decisionSignature(d: PackageDecision): string {
  return JSON.stringify([
    normTracking(d.trackingNumber), d.orderId, d.decision,
    d.decision === 'manual' ? d.reason : '',
    d.allocations.map(a => [a.reservationId, a.qty]),
  ]);
}

export interface DryRunEntry {
  orderId: number;
  orderNumber: string | null;
  trackingNumber: string;
  decision: 'exact' | 'manual';
  reason: string | null;
  message: string;
  /** what would be sent: one row per reservation line. Empty for manual. */
  wouldSubmit: { reservationId: number; qty: number; trackingNumber: string }[];
  caveats: string[];
  signature: string;
}

export function toDryRunEntry(d: PackageDecision): DryRunEntry {
  return {
    orderId: d.orderId, orderNumber: d.orderNumber, trackingNumber: d.trackingNumber,
    decision: d.decision, reason: d.decision === 'manual' ? d.reason : null, message: d.message,
    wouldSubmit: d.allocations.map(a => ({ reservationId: a.reservationId, qty: a.qty, trackingNumber: d.trackingNumber })),
    caveats: d.caveats, signature: decisionSignature(d),
  };
}
