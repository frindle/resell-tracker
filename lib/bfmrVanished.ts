// A reservation the open-status pull no longer returns has either moved to a finished
// status (paid, cancelled, ...) or vanished. Instead of pulling every finished status
// on every sync, look each one up by its retailer order number (BFMR `search`).

import { reservationLineKey } from './bfmrReservationLineKey.ts';

export type LocalOpenRow = { lineKey: string | null; bfmrOrderId: string | null; status: string };

const FINISHED = new Set(['paid', 'cancelled', 'returned', 'return', 'set_aside', 'closed']);

/** Distinct order numbers of local open rows whose line is absent from the pull. Capped. */
export function vanishedOrderIds(local: LocalOpenRow[], seenKeys: Set<string>, cap = 5): string[] {
  const out: string[] = [];
  for (const r of local) {
    if (FINISHED.has(String(r.status).toLowerCase())) continue;
    if (!r.bfmrOrderId || !r.lineKey || seenKeys.has(r.lineKey)) continue;
    if (!out.includes(r.bfmrOrderId)) out.push(r.bfmrOrderId);
    if (out.length >= cap) break;
  }
  return out;
}

/** Keep only search hits for exactly this order (an ignored `search` must not leak rows). */
export function itemsForOrder(items: Record<string, unknown>[], orderId: string): Record<string, unknown>[] {
  return items.filter(i => String(i.order_id ?? '') === orderId);
}

const FINISHED_STATUSES = new Set(['paid', 'cancelled', 'returned', 'return', 'set_aside', 'closed']);

/**
 * Return ids of local rows to mark superseded.
 *
 * A local row is superseded when:
 *  1. its status is NOT finished (paid, cancelled, returned, return, set_aside, closed);
 *  2. its lineKey is ABSENT from the lookup lines (computed via reservationLineKey);
 *  3. the lookup has at least one line with the same item_id but a DIFFERENT
 *     reserve_id head (a replacement reservation);
 *  4. no lookup line shares the row's reserve_id head (split sibling guard).
 */
export function supersededRowIds(
  local: { id: number; lineKey: string; reserveId: string; itemId: string | number; status: string }[],
  lookupItems: unknown[]
): number[] {
  if (!Array.isArray(lookupItems)) return [];

  const result: number[] = [];

  for (const row of local) {
    // (1) status is not finished
    if (FINISHED_STATUSES.has(String(row.status).toLowerCase())) continue;

    // Collect lookup line keys and check for split sibling / replacement
    const rowReserveHead = row.reserveId.split('|')[0];

    let hasSplitSibling = false;
    let hasReplacement = false;

    for (const item of lookupItems) {
      if (!item || typeof item !== 'object') continue;
      const rk = reservationLineKey(item as Record<string, unknown>);
      const head = rk.split('|')[0];

      // Check for split sibling: any lookup line sharing the row's reserve_id head
      if (head === rowReserveHead) {
        hasSplitSibling = true;
      }

      // Check for replacement: same item_id but different reserve_id head
      if (head !== rowReserveHead) {
        const rowItemId = String(row.itemId);
        const itemItemId = String((item as Record<string, unknown>).item_id ?? '');
        if (itemItemId === rowItemId) {
          hasReplacement = true;
        }
      }
    }

    // Split sibling guard: must NOT supersede split siblings
    if (hasSplitSibling) continue;

    // Replacement condition
    if (hasReplacement) {
      result.push(row.id);
    }
  }

  return result;
}
