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

export function buildPurchaseRow(input: { reserveId: string; orderNo: string; qty: number | string; purchaseId?: string | null }): RestTrackerRow {
  throw new Error('not implemented: buildPurchaseRow');
}

export function buildShipmentRow(input: { reserveId: string; purchaseId: string; orderNo: string; trackingNumber: string; qty: number | string }): RestTrackerRow {
  throw new Error('not implemented: buildShipmentRow');
}

export function buildShipmentUpdateRow(input: { reserveId: string; purchaseId: string; shipmentId: string; trackingNumber: string; qty: number | string; orderNo?: string | null }): RestTrackerRow {
  throw new Error('not implemented: buildShipmentUpdateRow');
}
