// Pure decision logic for sync-reservations: when BFMR assigns a purchase_id or
// shipment_id to a line we already stored without it, reservationLineKey
// changes (head|purchaseId|shipmentId) and a plain upsert would insert a SECOND
// row (and leave the old row + its OrderBfmrLink behind, doubling salePrice).
// Instead the old row is ADOPTED: its lineKey is rewritten to the new key so the
// upsert hits it.
//
// Two cases:
//   1. shipment_id assigned: "R|P|" -> "R|P|S" (same purchase).
//   2. purchase_id assigned: "R||" -> "R|P|" or "R|P|S". Only when the sync
//      pulled every open line (adoptUnpurchased), and only when "R||" itself
//      was not returned, because a split keeps an unpurchased remainder under
//      that key and that row must stay.
import { reservationLineKey } from './bfmrReservationLineKey.ts';
import type { RawReservationLine } from './bfmrReservationLineKey.ts';

export interface ExistingReservationRow {
  id: number;
  lineKey: string | null;
  reserveId: string | null;
  purchaseId: string | null;
  shipmentId: string | null;
}

export interface LineKeyAdoption {
  id: number;
  fromLineKey: string | null;
  toLineKey: string;
}

export interface AdoptOptions {
  /** Line keys BFMR returned in this sync. */
  itemKeys?: ReadonlySet<string>;
  /** The sync pulled every open line (scope 'open' or 'all'), so a missing "R||" really is gone. */
  adoptUnpurchased?: boolean;
}

const s = (v: unknown): string => (v === null || v === undefined ? '' : String(v));

export function planLineKeyAdoptions(
  items: RawReservationLine[],
  existing: ExistingReservationRow[],
  opts: AdoptOptions = {},
): LineKeyAdoption[] {
  const existingKeys = new Set(existing.map((r) => r.lineKey));
  const itemKeys = opts.itemKeys ?? new Set(items.map((i) => reservationLineKey(i)));
  const claimed = new Set<number>();
  const out: LineKeyAdoption[] = [];
  const adopt = (old: ExistingReservationRow, toLineKey: string) => {
    claimed.add(old.id);
    existingKeys.add(toLineKey);
    out.push({ id: old.id, fromLineKey: old.lineKey, toLineKey });
  };

  // Pass 1: shipment assigned to a known purchase.
  for (const item of items) {
    const reserveId = s(item.reserve_id);
    const purchaseId = s(item.purchase_id);
    if (!reserveId || !purchaseId || !s(item.shipment_id)) continue;
    const toLineKey = reservationLineKey(item);
    if (existingKeys.has(toLineKey)) continue; // row already exists: plain upsert
    const old = existing.find(
      (r) =>
        !claimed.has(r.id) &&
        r.shipmentId === null &&
        r.reserveId === reserveId &&
        r.purchaseId === purchaseId &&
        r.lineKey !== toLineKey,
    );
    if (old) adopt(old, toLineKey);
  }

  if (!opts.adoptUnpurchased) return out;

  // Pass 2: purchase assigned to a reservation stored before it was bought.
  for (const item of items) {
    const reserveId = s(item.reserve_id);
    if (!reserveId || !s(item.purchase_id)) continue;
    const toLineKey = reservationLineKey(item);
    if (existingKeys.has(toLineKey)) continue;
    const old = existing.find(
      (r) =>
        !claimed.has(r.id) &&
        r.reserveId === reserveId &&
        r.purchaseId === null &&
        r.shipmentId === null &&
        r.lineKey !== null &&
        r.lineKey !== toLineKey &&
        !itemKeys.has(r.lineKey),
    );
    if (old) adopt(old, toLineKey);
  }
  return out;
}

export interface StaleReservedRow extends ExistingReservationRow {
  status: string;
  links: number;
}

/**
 * Rows left behind by the purchase case above before it was handled: a
 * 'reserved' line with no purchase, no shipment and nothing linked to it,
 * which BFMR no longer returns, while a sibling with the same reserve_id has
 * a purchase. Only meaningful after a sync that pulled every open line.
 */
export function staleReservedRowIds(rows: readonly StaleReservedRow[], itemKeys: ReadonlySet<string>): number[] {
  const purchased = new Set(rows.filter((r) => r.reserveId && r.purchaseId).map((r) => r.reserveId));
  return rows
    .filter(
      (r) =>
        r.status === 'reserved' &&
        r.links === 0 &&
        r.purchaseId === null &&
        r.shipmentId === null &&
        r.reserveId !== null &&
        purchased.has(r.reserveId) &&
        r.lineKey !== null &&
        !itemKeys.has(r.lineKey),
    )
    .map((r) => r.id);
}
