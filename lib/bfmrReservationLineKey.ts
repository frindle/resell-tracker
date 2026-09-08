/**
 * Stable, non-null per-line key for a raw BFMR reservation row.
 *
 * A BFMR reservation SPLIT returns two lines that share one reserve_id but
 * never share both purchase_id and shipment_id (a shipped purchase vs an
 * unshipped remainder are different lines). Keying on all three separates split
 * halves while an exact refetch -- identical on all three -- still collapses.
 * The head segment falls back to purchase_id then shipment_id when reserve_id
 * is absent, matching the old `reserve_id ?? purchase_id ?? shipment_id`.
 */
export interface RawReservationLine {
  reserve_id?: unknown;
  purchase_id?: unknown;
  shipment_id?: unknown;
  [k: string]: unknown;
}

const seg = (v: unknown): string => (v === null || v === undefined ? '' : String(v));

export function reservationLineKey(item: RawReservationLine): string {
  const head = seg(item.reserve_id) || seg(item.purchase_id) || seg(item.shipment_id);
  return head + '|' + seg(item.purchase_id) + '|' + seg(item.shipment_id);
}

/** First-wins dedupe by reservationLineKey -- every distinct split line survives. */
export function dedupeReservationLines<T extends RawReservationLine>(items: T[]): T[] {
  const seen = new Map<string, T>();
  for (const it of items) {
    const k = reservationLineKey(it);
    if (!seen.has(k)) seen.set(k, it);
  }
  return [...seen.values()];
}
