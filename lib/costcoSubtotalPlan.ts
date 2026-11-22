import { isCostco } from './costcoReward.ts';

// Which Costco orders still need their merchandise subtotal (the Costco
// Executive reward's base, lib/costcoReward.ts) read from Costco's order
// page, and how they are split into sidecar commands. Pure, so it can be
// tested without a database; lib/costcoSubtotalFill.ts does the queueing.
//
// Locked orders are included: the subtotal is the one thing the import route
// writes on them (a subtotalOnly row, app/api/import/route.ts).

/** The sidecar reads at most this many order pages per command (MAX_DETAIL_ORDERS in sidecar/src/costco.js). */
export const SUBTOTAL_CHUNK = 25;

export type SubtotalCandidate = {
  platform: string | null;
  orderNumber: string | null;
  cancelled: boolean | null;
  merchandiseSubtotal: number | null;
};

export type SubtotalPayload = { orderNumbers: string[]; userId: number; subtotalOnly: true };

const digits = (n: string | null | undefined) => String(n ?? '').replace(/\D/g, '');

/** Order numbers (digits only) to read: Costco, not cancelled, no subtotal yet, not already waiting in a command. */
export function subtotalOrderNumbers(orders: readonly SubtotalCandidate[], waiting: Iterable<string> = []): string[] {
  const skip = new Set([...waiting].map(digits));
  const out: string[] = [];
  for (const o of orders) {
    if (!isCostco(o.platform) || o.cancelled || o.merchandiseSubtotal != null) continue;
    const n = digits(o.orderNumber);
    if (n && !skip.has(n) && !out.includes(n)) out.push(n);
  }
  return out;
}

/** One SYNC_COSTCO_ORDER payload per SUBTOTAL_CHUNK orders. */
export function subtotalPayloads(orderNumbers: readonly string[], userId: number, size: number = SUBTOTAL_CHUNK): SubtotalPayload[] {
  const out: SubtotalPayload[] = [];
  for (let i = 0; i < orderNumbers.length; i += size) out.push({ orderNumbers: orderNumbers.slice(i, i + size), userId, subtotalOnly: true });
  return out;
}

/** A stored command payload that is a subtotal read (it must not take gap-fill orders, and its misses are not fill failures). */
export function isSubtotalPayload(payload: string | null | undefined): boolean {
  try {
    return JSON.parse(payload ?? '{}')?.subtotalOnly === true;
  } catch {
    return false;
  }
}

/** The order numbers a stored payload names, digits only. */
export function payloadOrderNumbers(payload: string | null | undefined): string[] {
  try {
    const v = JSON.parse(payload ?? '{}')?.orderNumbers;
    return Array.isArray(v) ? v.map(n => digits(String(n))).filter(Boolean) : [];
  } catch {
    return [];
  }
}

/**
 * What a subtotalOnly import row writes on the order it matched: the subtotal,
 * only when a live Costco order has none yet (a typed or earlier one wins). Null = nothing.
 */
export function subtotalFill(
  existing: { platform: string | null; cancelled: boolean | null; merchandiseSubtotal: number | null },
  row: { merchandiseSubtotal?: number | null },
): number | null {
  if (!isCostco(existing.platform) || existing.cancelled || existing.merchandiseSubtotal != null) return null;
  return typeof row.merchandiseSubtotal === 'number' ? row.merchandiseSubtotal : null;
}
