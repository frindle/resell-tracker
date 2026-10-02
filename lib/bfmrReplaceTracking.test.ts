/**
 *   node --experimental-strip-types --test lib/bfmrReplaceTracking.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReplaceTrackingPayload, pickShipmentRow } from './bfmrReplaceTracking.ts';

// --- buildReplaceTrackingPayload ---

test('happy path: returns payload with trimmed tracking, preserves all other fields', () => {
  const row = {
    id: 'ship-001',
    type: 'shipment',
    status: 'shipped',
    tracking_number: 'OLD123',
    carrier: 'UPS',
    amount: 100,
  };
  const result = buildReplaceTrackingPayload(row, 'NEW456', { start: '2024-01-01', end: '2024-12-31' });
  assert.equal(result.tracker_data.length, 1);
  assert.equal(result.tracker_data[0].tracking_number, 'NEW456');
  assert.equal(result.tracker_data[0].id, 'ship-001');
  assert.equal(result.tracker_data[0].carrier, 'UPS');
  assert.equal(result.tracker_data[0].amount, 100);
  assert.equal(result.dateRange.start, '2024-01-01');
  assert.equal(result.dateRange.end, '2024-12-31');
  // Input row must NOT be mutated (common wrong fix: mutate in place)
  assert.equal(row.tracking_number, 'OLD123');
});

test('trims whitespace from newTracking before storing', () => {
  const row = {
    id: 'ship-001',
    type: 'shipment',
    status: 'shipped',
    tracking_number: 'OLD123',
  };
  const result = buildReplaceTrackingPayload(row, '  NEW456  ', {});
  assert.equal(result.tracker_data[0].tracking_number, 'NEW456');
});

test('throws Error when newTracking is empty string', () => {
  const row = {
    id: 'ship-001',
    type: 'shipment',
    status: 'shipped',
    tracking_number: 'OLD123',
  };
  assert.throws(() => buildReplaceTrackingPayload(row, '', {}), Error);
});

test('throws Error when newTracking is whitespace-only', () => {
  const row = {
    id: 'ship-001',
    type: 'shipment',
    status: 'shipped',
    tracking_number: 'OLD123',
  };
  assert.throws(() => buildReplaceTrackingPayload(row, '   ', {}), Error);
});

test('throws Error when newTracking equals current tracking_number (no-op)', () => {
  const row = {
    id: 'ship-001',
    type: 'shipment',
    status: 'shipped',
    tracking_number: 'OLD123',
  };
  assert.throws(() => buildReplaceTrackingPayload(row, 'OLD123', {}), Error);
});

test('throws Error when row.type is not "shipment"', () => {
  const row = {
    id: 'ship-001',
    type: 'return',
    status: 'shipped',
    tracking_number: 'OLD123',
  };
  assert.throws(() => buildReplaceTrackingPayload(row, 'NEW456', {}), Error);
});

test('throws Error when row.status is not "shipped"', () => {
  const row = {
    id: 'ship-001',
    type: 'shipment',
    status: 'pending',
    tracking_number: 'OLD123',
  };
  assert.throws(() => buildReplaceTrackingPayload(row, 'NEW456', {}), Error);
});

// --- pickShipmentRow ---

test('pickShipmentRow: returns the matching shipment row', () => {
  const rows = [
    { id: 'ship-001', type: 'shipment', tracking_number: 'ABC' },
    { id: 'ship-002', type: 'shipment', tracking_number: 'DEF' },
    { id: 'item-001', type: 'item', tracking_number: 'GHI' },
  ];
  const result = pickShipmentRow(rows, 'ship-002');
  assert.equal(result.id, 'ship-002');
  assert.equal(result.type, 'shipment');
});

test('pickShipmentRow: throws Error when no matching row', () => {
  const rows = [
    { id: 'ship-001', type: 'shipment', tracking_number: 'ABC' },
  ];
  assert.throws(() => pickShipmentRow(rows, 'ship-999'), Error);
});

test('pickShipmentRow: throws Error when multiple matching rows', () => {
  const rows = [
    { id: 'ship-001', type: 'shipment', tracking_number: 'ABC' },
    { id: 'ship-001', type: 'shipment', tracking_number: 'DEF' },
  ];
  assert.throws(() => pickShipmentRow(rows, 'ship-001'), Error);
});
