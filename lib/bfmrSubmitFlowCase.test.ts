/**
 * Tests for case-insensitive idempotency on tracking numbers in BFMR submit flow.
 *
 * Runs with: node --experimental-strip-types --test lib/bfmrSubmitFlowCase.test.ts
 *
 * The live defect (order 997): stored tracking "1z9481940396532588" did not match
 * BFMR's "1Z9481940396532588" — isAlreadyRecorded returned false, causing a
 * second POST and a double row in BFMR.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { isAlreadyRecorded, canonicalBfmrTracking } from './bfmrSubmitFlow.ts';

test('canonicalBfmrTracking trims and upper-cases', () => {
  assert.equal(canonicalBfmrTracking('  1z9481940396532588 '), '1Z9481940396532588');
});

test('isAlreadyRecorded does not match a different tracking number', () => {
  assert.equal(
    isAlreadyRecorded([{ qty: 1, trackingNumber: '1Z111' }], [{ qty: 1, trackingNumber: '1z222' }]),
    false,
  );
});

// --- isAlreadyRecorded case-insensitive tests --------------------------------

test('isAlreadyRecorded matches case-insensitively: mixed-case row vs uppercase record', () => {
  // The record has uppercase tracking; the row has lowercase — currently
  // isAlreadyRecorded returns false because of exact-case === comparison.
  const records: { qty: number; trackingNumber: string }[] = [
    { qty: 1, trackingNumber: '1Z9481940396532588' },
  ];
  const rows: { qty: number; trackingNumber: string }[] = [
    { qty: 1, trackingNumber: '1z9481940396532588' },
  ];
  const result = isAlreadyRecorded(records, rows);
  assert.equal(result, true, 'case mismatch should NOT prevent idempotent match');
});

test('isAlreadyRecorded matches case-insensitively: uppercase row vs lowercase record', () => {
  const records: { qty: number; trackingNumber: string }[] = [
    { qty: 1, trackingNumber: '1z9481940396532588' },
  ];
  const rows: { qty: number; trackingNumber: string }[] = [
    { qty: 1, trackingNumber: '1Z9481940396532588' },
  ];
  const result = isAlreadyRecorded(records, rows);
  assert.equal(result, true, 'case mismatch should NOT prevent idempotent match');
});

test('isAlreadyRecorded still rejects when qty is insufficient despite case-insensitive match', () => {
  // Only 1 unit recorded but row requests 2 — should return false regardless of case.
  const records: { qty: number; trackingNumber: string }[] = [
    { qty: 1, trackingNumber: '1Z9481940396532588' },
  ];
  const rows: { qty: number; trackingNumber: string }[] = [
    { qty: 2, trackingNumber: '1z9481940396532588' },
  ];
  const result = isAlreadyRecorded(records, rows);
  assert.equal(result, false, 'insufficient qty should still reject even with case match');
});

test('isAlreadyRecorded aggregates multiple records case-insensitively to meet qty', () => {
  // Two records of qty 1 each cover a row requesting qty 2, with mixed case.
  const records: { qty: number; trackingNumber: string }[] = [
    { qty: 1, trackingNumber: '1Z9481940396532588' },
    { qty: 1, trackingNumber: '1z9481940396532588' },
  ];
  const rows: { qty: number; trackingNumber: string }[] = [
    { qty: 2, trackingNumber: '1Z9481940396532588' },
  ];
  const result = isAlreadyRecorded(records, rows);
  assert.equal(result, true, 'aggregated qty across case variants should cover the row');
});
