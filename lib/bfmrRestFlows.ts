// Pure flow logic for BFMR REST v2 writes (fetch injected; routes stay thin).
import { buildShipmentRow, buildPurchaseRow, type RestTrackerRow } from './bfmrRestPayload.ts';
import { submitTrackerRows, verifyByTrackings, type FetchLike, type RestCreds } from './bfmrRestSubmit.ts';

/** BFMR was never asked to write, so a retry is safe (route answers 409). */
export class RestNotSubmittedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RestNotSubmittedError';
  }
  static is(e: unknown): e is RestNotSubmittedError {
    return e instanceof RestNotSubmittedError;
  }
}

export type RestReservation = {
  reserveId: string | null;
  purchaseId: string | null;
  bfmrOrderId: string | null;
};

const canon = (t: string) => t.trim().toUpperCase();

/** fetch adapter for FetchLike with a hard timeout (30s POST, 8s verify GET). */
export function makeRestFetch(timeoutMs: number): FetchLike {
  return (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) }) as ReturnType<FetchLike>;
}

/** REST twin of findMissingBfmrId, in check order. */
export function findMissingRestId(res: RestReservation): 'bfmrOrderId' | 'reserveId' | 'purchaseId' | null {
  if (!res.bfmrOrderId) return 'bfmrOrderId';
  if (!res.reserveId) return 'reserveId';
  if (!res.purchaseId) return 'purchaseId';
  return null;
}

export function planReservationShipments(
  res: RestReservation,
  rows: { qty: number; trackingNumber: string }[],
): RestTrackerRow[] {
  if (!res.reserveId) throw new RestNotSubmittedError('reservation has no reserveId — sync reservations from BFMR first');
  if (!res.purchaseId) throw new RestNotSubmittedError('reservation has no purchaseId — push the order number first');
  if (!res.bfmrOrderId) throw new RestNotSubmittedError('reservation has no bfmrOrderId — link it to an order first');

  // Merge case-insensitive duplicate trackings by summing qty.
  const merged: { qty: number; trackingNumber: string }[] = [];
  const seen = new Map<string, number>();
  for (const r of rows) {
    const key = canon(String(r.trackingNumber ?? ''));
    const at = seen.get(key);
    if (key !== '' && at !== undefined) {
      merged[at].qty += r.qty;
    } else {
      seen.set(key, merged.length);
      merged.push({ qty: r.qty, trackingNumber: r.trackingNumber });
    }
  }

  try {
    return merged.map((r) =>
      buildShipmentRow({
        reserveId: res.reserveId as string,
        purchaseId: res.purchaseId as string,
        orderNo: res.bfmrOrderId as string,
        trackingNumber: r.trackingNumber,
        qty: r.qty,
      }),
    );
  } catch (e) {
    throw new RestNotSubmittedError(e instanceof Error ? e.message : String(e));
  }
}

export async function submitReservationRest(
  fetchImpl: FetchLike,
  creds: RestCreds,
  res: RestReservation,
  rows: { qty: number; trackingNumber: string }[],
): Promise<{ valid: unknown[] }> {
  const planned = planReservationShipments(res, rows);
  const { valid, invalid } = await submitTrackerRows(fetchImpl, creds, planned);
  if (invalid.length > 0 && valid.length === 0) {
    // LIVE assumption: an all-invalid response wrote nothing.
    throw new RestNotSubmittedError('BFMR rejected: ' + JSON.stringify(invalid).slice(0, 300));
  }
  if (invalid.length > 0) {
    throw new Error('BFMR partially accepted: ' + JSON.stringify(invalid).slice(0, 300));
  }
  return { valid };
}

/* ── U6: order-number push on link ───────────────────────────────────── */

/**
 * `split` is decided from the LOCAL reservation qty (the web path used BFMR's
 * live qty). Whether a smaller-qty Create Purchase splits on BFMR is a LIVE
 * check; until confirmed, do not use the flip for partial links.
 */
export function planOrderNumberPush(
  res: { reserveId: string | null; purchaseId: string | null; qty: number },
  quantity: number,
  orderNumber: string,
): { row: RestTrackerRow; split: boolean } {
  if (quantity > res.qty) {
    throw new Error(`quantity ${quantity} exceeds reservation qty ${res.qty}`);
  }
  const row = buildPurchaseRow({
    reserveId: res.reserveId as string,
    orderNo: orderNumber,
    qty: quantity,
    purchaseId: res.purchaseId,
  });
  return { row, split: quantity < res.qty };
}

export async function pushOrderNumberRest(
  fetchImpl: FetchLike,
  creds: RestCreds,
  res: { reserveId: string | null; purchaseId: string | null; qty: number },
  quantity: number,
  orderNumber: string,
  opts: { dryRun?: boolean } = {},
): Promise<{ payload: RestTrackerRow; split: boolean; bfmrQty: number; dryRun?: true }> {
  const { row, split } = planOrderNumberPush(res, quantity, orderNumber);
  if (opts.dryRun) return { payload: row, split, bfmrQty: res.qty, dryRun: true };
  const { invalid } = await submitTrackerRows(fetchImpl, creds, [row]);
  if (invalid.length > 0) {
    throw new Error('BFMR rejected: ' + JSON.stringify(invalid).slice(0, 300));
  }
  return { payload: row, split, bfmrQty: res.qty };
}

export async function reconcileReservationRest(
  fetchImpl: FetchLike,
  creds: RestCreds,
  res: RestReservation,
  expected: string,
) {
  if (!res.reserveId) throw new Error('reconcileReservationRest: reservation has no reserveId');
  return verifyByTrackings(
    fetchImpl,
    creds,
    { reserveId: res.reserveId, purchaseId: res.purchaseId },
    expected,
    { attempts: 2, delayMs: 1500 },
  );
}
