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

/* ── U7: bulk push-tracking ───────────────────────────────────────────── */

export type BulkAttribution = { reserveId: string; purchaseId: string; qty: number; trackingNumber: string };

/**
 * Pure planner. GET rows say `order_id`; the POST field is `order_no`.
 * Trackings already on any of an order's rows (case-insensitive) are dropped;
 * rows that already have a tracking, or have no purchase_id, are skipped; each
 * remaining row takes the next tracking in order. A row whose builder throws is
 * skipped (and does not consume a tracking).
 */
export function planBulkShipments(
  trackerRows: Record<string, unknown>[],
  trackingMap: Record<string, string[]>,
): { rows: RestTrackerRow[]; attributions: BulkAttribution[] } {
  const norm = (v: unknown) => (v == null ? '' : String(v).trim());
  const mapByOrder = new Map<string, string[]>();
  for (const [k, v] of Object.entries(trackingMap)) mapByOrder.set(k.trim(), v);

  const rowsByOrder = new Map<string, Record<string, unknown>[]>();
  for (const row of trackerRows) {
    const key = norm(row.order_id);
    if (!key || !mapByOrder.has(key)) continue;
    const list = rowsByOrder.get(key) ?? [];
    list.push(row);
    rowsByOrder.set(key, list);
  }

  const rows: RestTrackerRow[] = [];
  const attributions: BulkAttribution[] = [];
  for (const [orderKey, orderRows] of rowsByOrder) {
    const present = new Set(orderRows.map((r) => canon(norm(r.tracking_number))).filter((t) => t !== ''));
    const queue: string[] = [];
    const queued = new Set<string>();
    for (const t of mapByOrder.get(orderKey) ?? []) {
      const c = canon(String(t ?? ''));
      if (c === '' || present.has(c) || queued.has(c)) continue;
      queued.add(c);
      queue.push(String(t).trim());
    }
    for (const r of orderRows) {
      if (queue.length === 0) break;
      if (norm(r.tracking_number) !== '') continue;
      if (norm(r.purchase_id) === '') continue;
      const trackingNumber = queue[0];
      try {
        const built = buildShipmentRow({
          reserveId: norm(r.reserve_id),
          purchaseId: norm(r.purchase_id),
          orderNo: norm(r.order_id),
          trackingNumber,
          qty: r.qty as number,
        });
        queue.shift();
        rows.push(built);
        attributions.push({
          reserveId: built.reserve_id,
          purchaseId: built.purchase_id as string,
          qty: built.qty,
          trackingNumber: built.tracking_number as string,
        });
      } catch {
        // skipped, not fatal
      }
    }
  }
  return { rows, attributions };
}

export async function pushTrackingRest(
  fetchImpl: FetchLike,
  creds: RestCreds,
  trackingMap: Record<string, string[]>,
  opts: { getFetch?: FetchLike } = {},
): Promise<BulkAttribution[]> {
  const getFetch = opts.getFetch ?? fetchImpl;
  const orderNos = Object.keys(trackingMap).map((o) => o.trim()).filter(Boolean);
  const trackerRows: Record<string, unknown>[] = [];
  const PAGE_SIZE = 200;
  const MAX_PAGES = 25; // runaway guard, same bound as getMyTrackerAll
  for (let i = 0; i < orderNos.length; i += 50) {
    // Page until a short page: page_size alone silently truncates (see
    // getMyTrackerAll in lib/bfmr.ts), which would leave rows unpushed.
    for (let page = 1; page <= MAX_PAGES; page++) {
      const params = new URLSearchParams();
      for (const o of orderNos.slice(i, i + 50)) params.append('orders[]', o);
      params.set('quick_filter', 'all');
      params.set('page_size', String(PAGE_SIZE));
      params.set('page_no', String(page));
      const res = await getFetch('https://api.bfmr.com/api/v2/my-tracker?' + params.toString(), {
        method: 'GET',
        headers: { 'API-KEY': creds.apiKey, 'API-SECRET': creds.apiSecret },
      });
      if (!res.ok) throw new Error('BFMR ' + res.status + ': ' + (await res.text()).slice(0, 200));
      const body = await res.json();
      const arr = Array.isArray(body?.my_tracker) ? body.my_tracker : [];
      trackerRows.push(...(arr as Record<string, unknown>[]));
      if (arr.length < PAGE_SIZE) break;
    }
  }

  const { rows, attributions } = planBulkShipments(trackerRows, trackingMap);
  const confirmed: BulkAttribution[] = [];
  for (let i = 0; i < rows.length; i += 500) {
    const chunkRows = rows.slice(i, i + 500);
    const chunkAttr = attributions.slice(i, i + 500);
    const { valid, invalid } = await submitTrackerRows(fetchImpl, creds, chunkRows);
    const mappable = valid.every(
      (v) => v != null && typeof v === 'object' && 'reserve_id' in (v as object) && 'purchase_id' in (v as object),
    );
    if (valid.length > 0 && mappable) {
      const ok = new Set(valid.map((v) => `${String((v as any).reserve_id)}|${String((v as any).purchase_id)}`));
      confirmed.push(...chunkAttr.filter((a) => ok.has(`${a.reserveId}|${a.purchaseId}`)));
    } else if (invalid.length === 0) {
      confirmed.push(...chunkAttr);
    }
  }
  return confirmed;
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
