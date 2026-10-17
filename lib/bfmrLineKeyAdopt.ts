// Pure decision logic for sync-reservations: when BFMR assigns a shipment_id to
// a line we already stored with shipmentId null, reservationLineKey changes
// (head|purchaseId|shipmentId) and a plain upsert would insert a SECOND row
// (and leave the old row + its OrderBfmrLink behind, doubling salePrice).
// Instead the old row is ADOPTED: its lineKey is rewritten to the new key so the
// upsert hits it.
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

const s = (v: unknown): string => (v === null || v === undefined ? '' : String(v));

export function planLineKeyAdoptions(
  items: RawReservationLine[],
  existing: ExistingReservationRow[],
): LineKeyAdoption[] {
  const existingKeys = new Set(existing.map((r) => r.lineKey));
  const claimed = new Set<number>();
  const out: LineKeyAdoption[] = [];
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
    if (!old) continue;
    claimed.add(old.id);
    existingKeys.add(toLineKey);
    out.push({ id: old.id, fromLineKey: old.lineKey, toLineKey });
  }
  return out;
}
