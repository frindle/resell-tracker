// Row builders for BFMR REST v2 `POST /api/v2/my-tracker` ({ tracker_data: [row] }).
// The POST names the retailer order number `order_no`; GET rows call it `order_id`.

export type RestTrackerRow = {
  reserve_id: string;
  purchase_id?: string | null;
  shipment_id?: string | null;
  order_no?: string | null;
  tracking_number?: string | null;
  qty: number;
};

/* ── helpers ─────────────────────────────────────────────────────────── */

/** Validate a required string field: must be typeof === 'string', trimmed, non-empty. */
function assertRequired(value: unknown, fieldName: string, fnName: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${fnName}: missing ${fieldName}`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${fnName}: missing ${fieldName}`);
  }
  return trimmed;
}

/** Convert and validate qty: must be a finite integer >= 1. */
function normalizeQty(qty: number | string, fnName: string): number {
  const n = Number(qty);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
    throw new Error(`${fnName}: bad qty`);
  }
  return n;
}

/* ── buildPurchaseRow ─────────────────────────────────────────────────── */

export function buildPurchaseRow(input: { reserveId: string; orderNo: string; qty: number | string; purchaseId?: string | null }): RestTrackerRow {
  const reserve_id = assertRequired(input.reserveId, 'reserve_id', 'buildPurchaseRow');
  const order_no = assertRequired(input.orderNo, 'order_no', 'buildPurchaseRow');
  const qty = normalizeQty(input.qty, 'buildPurchaseRow');

  // Optional purchaseId: only use if it's a non-empty string after trim
  let purchase_id: string | null = null;
  if (typeof input.purchaseId === 'string' && input.purchaseId.trim().length > 0) {
    purchase_id = input.purchaseId.trim();
  }

  return { reserve_id, purchase_id, shipment_id: null, order_no, tracking_number: null, qty };
}

/* ── buildShipmentRow ─────────────────────────────────────────────────── */

export function buildShipmentRow(input: { reserveId: string; purchaseId: string; orderNo: string; trackingNumber: string; qty: number | string }): RestTrackerRow {
  const reserve_id = assertRequired(input.reserveId, 'reserve_id', 'buildShipmentRow');
  const purchase_id = assertRequired(input.purchaseId, 'purchase_id', 'buildShipmentRow');
  const order_no = assertRequired(input.orderNo, 'order_no', 'buildShipmentRow');
  const tracking_number = assertRequired(input.trackingNumber, 'tracking_number', 'buildShipmentRow');
  const qty = normalizeQty(input.qty, 'buildShipmentRow');

  return { reserve_id, purchase_id, shipment_id: null, order_no, tracking_number, qty };
}

/* ── buildShipmentUpdateRow ───────────────────────────────────────────── */

export function buildShipmentUpdateRow(input: { reserveId: string; purchaseId: string; shipmentId: string; trackingNumber: string; qty: number | string; orderNo?: string | null }): RestTrackerRow {
  const reserve_id = assertRequired(input.reserveId, 'reserve_id', 'buildShipmentUpdateRow');
  const purchase_id = assertRequired(input.purchaseId, 'purchase_id', 'buildShipmentUpdateRow');
  const shipment_id = assertRequired(input.shipmentId, 'shipment_id', 'buildShipmentUpdateRow');
  const tracking_number = assertRequired(input.trackingNumber, 'tracking_number', 'buildShipmentUpdateRow');
  const qty = normalizeQty(input.qty, 'buildShipmentUpdateRow');

  // Optional orderNo: include order_no only when it's a non-empty string after trim
  let order_no: string | undefined = undefined;
  if (typeof input.orderNo === 'string' && input.orderNo.trim().length > 0) {
    order_no = input.orderNo.trim();
  }

  const row: RestTrackerRow = { reserve_id, purchase_id, shipment_id, tracking_number, qty };
  if (order_no !== undefined) {
    row.order_no = order_no;
  }
  return row;
}
