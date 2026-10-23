/**
 * Tests for BFMR REST v2 row builders.
 *
 *   node --experimental-strip-types --test lib/bfmrRestPayload.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildPurchaseRow, buildShipmentRow, buildShipmentUpdateRow } from './bfmrRestPayload.ts';

// Realistic identifiers from TASK.md
const RESERVE = 'bD8tc+lctALUUcVtjfp80g==';
const PURCHASE = 'vwtYlt+9DZUYgDNtr+AQoQ==';
const SHIPMENT = 'wzHGFR60U7jBMEsHUsSNBw==';
const ORDER = '111-2213508-9161019';
const TRACKING = 'TBA335696557507';
const QTY = '3';

/* ── buildPurchaseRow: happy path (create) ──────────────────────────── */

test('buildPurchaseRow – create returns correct row', () => {
  const row = buildPurchaseRow({ reserveId: RESERVE, orderNo: ORDER, qty: QTY });
  assert.deepStrictEqual(row, {
    reserve_id: RESERVE,
    purchase_id: null,
    shipment_id: null,
    order_no: ORDER,
    tracking_number: null,
    qty: 3,
  });
  assert.strictEqual('order_id' in row, false);
});

/* ── buildPurchaseRow: happy path (update with purchaseId) ──────────── */

test('buildPurchaseRow – update trims and includes purchase_id', () => {
  const row = buildPurchaseRow({
    reserveId: RESERVE,
    orderNo: ORDER,
    qty: QTY,
    purchaseId: ` ${PURCHASE} `,
  });
  assert.deepStrictEqual(row, {
    reserve_id: RESERVE,
    purchase_id: PURCHASE,
    shipment_id: null,
    order_no: ORDER,
    tracking_number: null,
    qty: 3,
  });
});

/* ── buildPurchaseRow: optional purchaseId edge cases ───────────────── */

test('buildPurchaseRow – numeric purchaseId is treated as not given → purchase_id: null', () => {
  const row = buildPurchaseRow({
    reserveId: RESERVE,
    orderNo: ORDER,
    qty: QTY,
    purchaseId: 5 as any,
  });
  assert.strictEqual(row.purchase_id, null);
});

test('buildPurchaseRow – empty-string purchaseId → purchase_id: null', () => {
  const row = buildPurchaseRow({
    reserveId: RESERVE,
    orderNo: ORDER,
    qty: QTY,
    purchaseId: '',
  });
  assert.strictEqual(row.purchase_id, null);
});

test('buildPurchaseRow – null purchaseId → purchase_id: null', () => {
  const row = buildPurchaseRow({
    reserveId: RESERVE,
    orderNo: ORDER,
    qty: QTY,
    purchaseId: null,
  });
  assert.strictEqual(row.purchase_id, null);
});

/* ── buildPurchaseRow: missing required fields ──────────────────────── */

test('buildPurchaseRow – missing reserve_id throws exact message', () => {
  assert.throws(
    () => buildPurchaseRow({ reserveId: undefined as any, orderNo: ORDER, qty: QTY }),
    (e: Error) => !(e instanceof TypeError) && /buildPurchaseRow: missing reserve_id/.test(e.message),
  );
});

test('buildPurchaseRow – null orderNo throws exact message', () => {
  assert.throws(
    () => buildPurchaseRow({ reserveId: RESERVE, orderNo: null as any, qty: QTY }),
    (e: Error) => !(e instanceof TypeError) && /buildPurchaseRow: missing order_no/.test(e.message),
  );
});

test('buildPurchaseRow – whitespace-only orderNo throws exact message', () => {
  assert.throws(
    () => buildPurchaseRow({ reserveId: RESERVE, orderNo: '  ', qty: QTY }),
    (e: Error) => !(e instanceof TypeError) && /buildPurchaseRow: missing order_no/.test(e.message),
  );
});

/* ── buildShipmentRow: happy path ───────────────────────────────────── */

test('buildShipmentRow – creates correct row', () => {
  const row = buildShipmentRow({
    reserveId: RESERVE,
    purchaseId: PURCHASE,
    orderNo: ORDER,
    trackingNumber: TRACKING,
    qty: QTY,
  });
  assert.deepStrictEqual(row, {
    reserve_id: RESERVE,
    purchase_id: PURCHASE,
    shipment_id: null,
    order_no: ORDER,
    tracking_number: TRACKING,
    qty: 3,
  });
  assert.strictEqual('order_id' in row, false);
});

/* ── buildShipmentRow: missing required fields ──────────────────────── */

test('buildShipmentRow – missing reserve_id throws exact message', () => {
  assert.throws(
    () => buildShipmentRow({ reserveId: undefined as any, purchaseId: PURCHASE, orderNo: ORDER, trackingNumber: TRACKING, qty: QTY }),
    (e: Error) => !(e instanceof TypeError) && /buildShipmentRow: missing reserve_id/.test(e.message),
  );
});

test('buildShipmentRow – null purchaseId throws exact message', () => {
  assert.throws(
    () => buildShipmentRow({ reserveId: RESERVE, purchaseId: null as any, orderNo: ORDER, trackingNumber: TRACKING, qty: QTY }),
    (e: Error) => !(e instanceof TypeError) && /buildShipmentRow: missing purchase_id/.test(e.message),
  );
});

test('buildShipmentRow – undefined orderNo throws exact message', () => {
  assert.throws(
    () => buildShipmentRow({ reserveId: RESERVE, purchaseId: PURCHASE, orderNo: undefined as any, trackingNumber: TRACKING, qty: QTY }),
    (e: Error) => !(e instanceof TypeError) && /buildShipmentRow: missing order_no/.test(e.message),
  );
});

test('buildShipmentRow – null trackingNumber throws exact message', () => {
  assert.throws(
    () => buildShipmentRow({ reserveId: RESERVE, purchaseId: PURCHASE, orderNo: ORDER, trackingNumber: null as any, qty: QTY }),
    (e: Error) => !(e instanceof TypeError) && /buildShipmentRow: missing tracking_number/.test(e.message),
  );
});

test('buildShipmentRow – empty trackingNumber throws exact message', () => {
  assert.throws(
    () => buildShipmentRow({ reserveId: RESERVE, purchaseId: PURCHASE, orderNo: ORDER, trackingNumber: '', qty: QTY }),
    (e: Error) => !(e instanceof TypeError) && /buildShipmentRow: missing tracking_number/.test(e.message),
  );
});

/* ── buildShipmentUpdateRow: happy path (with orderNo) ──────────────── */

test('buildShipmentUpdateRow – with orderNo includes order_no key', () => {
  const row = buildShipmentUpdateRow({
    reserveId: RESERVE,
    purchaseId: PURCHASE,
    shipmentId: SHIPMENT,
    trackingNumber: TRACKING,
    qty: QTY,
    orderNo: ORDER,
  });
  assert.deepStrictEqual(row, {
    reserve_id: RESERVE,
    purchase_id: PURCHASE,
    shipment_id: SHIPMENT,
    tracking_number: TRACKING,
    qty: 3,
    order_no: ORDER,
  });
  assert.strictEqual('order_id' in row, false);
});

/* ── buildShipmentUpdateRow: happy path (without orderNo) ───────────── */

test('buildShipmentUpdateRow – without orderNo omits the key', () => {
  const row = buildShipmentUpdateRow({
    reserveId: RESERVE,
    purchaseId: PURCHASE,
    shipmentId: SHIPMENT,
    trackingNumber: TRACKING,
    qty: QTY,
  });
  assert.deepStrictEqual(row, {
    reserve_id: RESERVE,
    purchase_id: PURCHASE,
    shipment_id: SHIPMENT,
    tracking_number: TRACKING,
    qty: 3,
  });
  assert.strictEqual('order_no' in row, false);
  assert.strictEqual('order_id' in row, false);
});

/* ── buildShipmentUpdateRow: missing required fields ────────────────── */

test('buildShipmentUpdateRow – missing reserve_id throws exact message', () => {
  assert.throws(
    () => buildShipmentUpdateRow({ reserveId: undefined as any, purchaseId: PURCHASE, shipmentId: SHIPMENT, trackingNumber: TRACKING, qty: QTY }),
    (e: Error) => !(e instanceof TypeError) && /buildShipmentUpdateRow: missing reserve_id/.test(e.message),
  );
});

test('buildShipmentUpdateRow – null shipmentId throws exact message', () => {
  assert.throws(
    () => buildShipmentUpdateRow({ reserveId: RESERVE, purchaseId: PURCHASE, shipmentId: null as any, trackingNumber: TRACKING, qty: QTY }),
    (e: Error) => !(e instanceof TypeError) && /buildShipmentUpdateRow: missing shipment_id/.test(e.message),
  );
});

test('buildShipmentUpdateRow – numeric trackingNumber throws exact message', () => {
  assert.throws(
    () => buildShipmentUpdateRow({ reserveId: RESERVE, purchaseId: PURCHASE, shipmentId: SHIPMENT, trackingNumber: 123 as any, qty: QTY }),
    (e: Error) => !(e instanceof TypeError) && /buildShipmentUpdateRow: missing tracking_number/.test(e.message),
  );
});

test('buildShipmentUpdateRow – numeric orderNo is treated as not given (no order_no key)', () => {
  const row = buildShipmentUpdateRow({
    reserveId: RESERVE,
    purchaseId: PURCHASE,
    shipmentId: SHIPMENT,
    trackingNumber: TRACKING,
    qty: QTY,
    orderNo: 42 as any,
  });
  assert.strictEqual('order_no' in row, false);
});

/* ── bad qty tests (all three builders) ─────────────────────────────── */

test('buildPurchaseRow – bad qty: 0 throws', () => {
  assert.throws(
    () => buildPurchaseRow({ reserveId: RESERVE, orderNo: ORDER, qty: 0 }),
    /buildPurchaseRow: bad qty/,
  );
});

test('buildPurchaseRow – bad qty: 1.5 throws', () => {
  assert.throws(
    () => buildPurchaseRow({ reserveId: RESERVE, orderNo: ORDER, qty: 1.5 }),
    /buildPurchaseRow: bad qty/,
  );
});

test('buildPurchaseRow – bad qty: "x" throws', () => {
  assert.throws(
    () => buildPurchaseRow({ reserveId: RESERVE, orderNo: ORDER, qty: 'x' }),
    /buildPurchaseRow: bad qty/,
  );
});

test('buildShipmentRow – bad qty: 0 throws', () => {
  assert.throws(
    () => buildShipmentRow({ reserveId: RESERVE, purchaseId: PURCHASE, orderNo: ORDER, trackingNumber: TRACKING, qty: 0 }),
    /buildShipmentRow: bad qty/,
  );
});

test('buildShipmentUpdateRow – bad qty: "x" throws', () => {
  assert.throws(
    () => buildShipmentUpdateRow({ reserveId: RESERVE, purchaseId: PURCHASE, shipmentId: SHIPMENT, trackingNumber: TRACKING, qty: 'x' }),
    /buildShipmentUpdateRow: bad qty/,
  );
});

/* ── trim behaviour ─────────────────────────────────────────────────── */

test('buildPurchaseRow – trims reserveId and orderNo', () => {
  const row = buildPurchaseRow({ reserveId: ` ${RESERVE} `, orderNo: ` ${ORDER} `, qty: QTY });
  assert.strictEqual(row.reserve_id, RESERVE);
  assert.strictEqual(row.order_no, ORDER);
});

test('buildShipmentRow – trims all string fields', () => {
  const row = buildShipmentRow({
    reserveId: ` ${RESERVE} `,
    purchaseId: ` ${PURCHASE} `,
    orderNo: ` ${ORDER} `,
    trackingNumber: ` ${TRACKING} `,
    qty: QTY,
  });
  assert.strictEqual(row.reserve_id, RESERVE);
  assert.strictEqual(row.purchase_id, PURCHASE);
  assert.strictEqual(row.order_no, ORDER);
  assert.strictEqual(row.tracking_number, TRACKING);
});

test('buildShipmentUpdateRow – trims all string fields', () => {
  const row = buildShipmentUpdateRow({
    reserveId: ` ${RESERVE} `,
    purchaseId: ` ${PURCHASE} `,
    shipmentId: ` ${SHIPMENT} `,
    trackingNumber: ` ${TRACKING} `,
    qty: QTY,
    orderNo: ` ${ORDER} `,
  });
  assert.strictEqual(row.reserve_id, RESERVE);
  assert.strictEqual(row.purchase_id, PURCHASE);
  assert.strictEqual(row.shipment_id, SHIPMENT);
  assert.strictEqual(row.tracking_number, TRACKING);
  assert.strictEqual(row.order_no, ORDER);
});
