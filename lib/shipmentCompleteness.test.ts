import test from 'node:test';
import assert from 'node:assert/strict';

import { isAwaitingMoreShipments, type CompletenessOrder } from './shipmentCompleteness.ts';

const NOW = new Date('2025-06-15T12:00:00Z');
const DAY = 86_400_000;

function order(over: Partial<CompletenessOrder> = {}): CompletenessOrder {
  return {
    platform: 'Amazon',
    orderNumber: '975-1234567-8901234',
    orderDate: NOW,
    salePrice: null,
    bgExpectedPayout: null,
    bgPaidAmount: null,
    trackingNumbers: null,
    trackingValues: null,
    bgCredited: null,
    bfmrReceived: null,
    lost: null,
    cancelled: null,
    salePriceSynced: null,
    ...over,
  };
}

test('missing trackingNumbers returns false (guard 1)', () => {
  const o = order({ bgPaidAmount: 100, salePrice: 500 });
  // guard 1 fails: trackingNumbers is null → returns false
  assert.equal(isAwaitingMoreShipments(o, NOW), false);
});

test('empty trackingNumbers after trim returns false (guard 1)', () => {
  const o = order({ trackingNumbers: '   ', bgPaidAmount: 100, salePrice: 500 });
  // guard 1 fails: whitespace-only → returns false
  assert.equal(isAwaitingMoreShipments(o, NOW), false);
});

test('non-empty trackingNumbers with arrival signal and shortfall returns true', () => {
  const o = order({
    trackingNumbers: 'ABC123,DEF456',
    trackingValues: JSON.stringify({ ABC123: 400, DEF456: 200 }),
    bgExpectedPayout: 899.91,
    salePrice: 899.91,
    bgPaidAmount: 600,
  });
  assert.equal(isAwaitingMoreShipments(o, NOW), true);
});

test('trackingValues parsed JSON sum used when greater than bgPaidAmount', () => {
  const o = order({
    trackingNumbers: 'AAA111,BBB222',
    trackingValues: JSON.stringify({ AAA111: 500, BBB222: 400 }),
    salePrice: 1000,
    bgPaidAmount: 100,
  });
  assert.equal(isAwaitingMoreShipments(o, NOW), true);
});

test('bgCredited true acts as arrival signal even with 0 bgPaidAmount', () => {
  const o = order({
    trackingNumbers: 'ZZZ999',
    trackingValues: JSON.stringify({ ZZZ999: 100 }),
    salePrice: 500,
    bgCredited: true,
  });
  assert.equal(isAwaitingMoreShipments(o, NOW), true);
});

test('bfmrReceived true acts as arrival signal', () => {
  const o = order({
    trackingNumbers: 'ZZZ888',
    trackingValues: JSON.stringify({ ZZZ888: 50 }),
    salePrice: 300,
    bfmrReceived: true,
  });
  assert.equal(isAwaitingMoreShipments(o, NOW), true);
});

test('order exactly at expected value returns false (no shortfall)', () => {
  const o = order({
    trackingNumbers: 'AAA111',
    trackingValues: JSON.stringify({ AAA111: 500 }),
    salePrice: 500,
  });
  assert.equal(isAwaitingMoreShipments(o, NOW), false);
});

test('order within 1% tolerance returns false', () => {
  const o = order({
    trackingNumbers: 'AAA111',
    trackingValues: JSON.stringify({ AAA111: 495 }),
    salePrice: 500,
  });
  assert.equal(isAwaitingMoreShipments(o, NOW), false);
});

test('order beyond 1% tolerance returns true', () => {
  const o = order({
    trackingNumbers: 'AAA111',
    trackingValues: JSON.stringify({ AAA111: 400 }),
    salePrice: 500,
    bgPaidAmount: 100,
  });
  assert.equal(isAwaitingMoreShipments(o, NOW), true);
});

test('lost order returns false (guard 6)', () => {
  const o = order({
    trackingNumbers: 'AAA111',
    trackingValues: JSON.stringify({ AAA111: 100 }),
    salePrice: 500,
    lost: true,
  });
  assert.equal(isAwaitingMoreShipments(o, NOW), false);
});

test('cancelled order returns false (guard 6)', () => {
  const o = order({
    trackingNumbers: 'AAA111',
    trackingValues: JSON.stringify({ AAA111: 100 }),
    salePrice: 500,
    cancelled: true,
  });
  assert.equal(isAwaitingMoreShipments(o, NOW), false);
});

test('salePriceSynced order returns false (guard 6)', () => {
  const o = order({
    trackingNumbers: 'AAA111',
    trackingValues: JSON.stringify({ AAA111: 100 }),
    salePrice: 500,
    salePriceSynced: true,
  });
  assert.equal(isAwaitingMoreShipments(o, NOW), false);
});

test('non-Amazon orderNumber format returns false (guard 7)', () => {
  const o = order({
    orderNumber: 'BAD-FORMAT',
    trackingNumbers: 'AAA111',
    trackingValues: JSON.stringify({ AAA111: 100 }),
    salePrice: 500,
  });
  assert.equal(isAwaitingMoreShipments(o, NOW), false);
});

test('order older than 45 days returns false (guard 8)', () => {
  const oldDate = new Date(NOW.getTime() - 46 * DAY);
  const o = order({
    orderDate: oldDate,
    trackingNumbers: 'AAA111',
    trackingValues: JSON.stringify({ AAA111: 100 }),
    salePrice: 500,
  });
  assert.equal(isAwaitingMoreShipments(o, NOW), false);
});

test('order exactly 45 days old returns true (within limit)', () => {
  const exactDate = new Date(NOW.getTime() - 45 * DAY);
  const o = order({
    orderDate: exactDate,
    trackingNumbers: 'AAA111',
    trackingValues: JSON.stringify({ AAA111: 100 }),
    salePrice: 500,
    bgPaidAmount: 100,
  });
  assert.equal(isAwaitingMoreShipments(o, NOW), true);
});

test('missing orderDate returns false (guard 8)', () => {
  const o = order({
    orderDate: undefined,
    trackingNumbers: 'AAA111',
    trackingValues: JSON.stringify({ AAA111: 100 }),
    salePrice: 500,
  });
  assert.equal(isAwaitingMoreShipments(o, NOW), false);
});

test('invalid orderDate string returns false (guard 8)', () => {
  const o = order({
    orderDate: 'not-a-date',
    trackingNumbers: 'AAA111',
    trackingValues: JSON.stringify({ AAA111: 100 }),
    salePrice: 500,
  });
  assert.equal(isAwaitingMoreShipments(o, NOW), false);
});

test('orderDate as ISO string works correctly', () => {
  const isoDate = '2025-05-01T12:00:00Z';
  const o = order({
    orderDate: isoDate,
    trackingNumbers: 'AAA111',
    trackingValues: JSON.stringify({ AAA111: 100 }),
    salePrice: 500,
    bgPaidAmount: 100,
  });
  assert.equal(isAwaitingMoreShipments(o, NOW), true);
});

test('no arrival signal (all false/null, bgPaidAmount=0) returns false (guard 2)', () => {
  const o = order({
    trackingNumbers: 'AAA111',
    trackingValues: JSON.stringify({ AAA111: 100 }),
    salePrice: 500,
    bgCredited: false,
    bfmrReceived: false,
    bgPaidAmount: 0,
  });
  assert.equal(isAwaitingMoreShipments(o, NOW), false);
});

test('expected from bgExpectedPayout when salePrice is null', () => {
  const o = order({
    trackingNumbers: 'AAA111',
    trackingValues: JSON.stringify({ AAA111: 100 }),
    salePrice: null,
    bgExpectedPayout: 500,
    bgPaidAmount: 100,
  });
  assert.equal(isAwaitingMoreShipments(o, NOW), true);
});

test('expected is max of salePrice and bgExpectedPayout', () => {
  const o = order({
    trackingNumbers: 'AAA111',
    trackingValues: JSON.stringify({ AAA111: 100 }),
    salePrice: 300,
    bgExpectedPayout: 500,
    bgPaidAmount: 100,
  });
  assert.equal(isAwaitingMoreShipments(o, NOW), true);
});

test('invalid trackingValues JSON counts as 0', () => {
  const o = order({
    trackingNumbers: 'AAA111',
    trackingValues: 'not-json',
    salePrice: 500,
    bgPaidAmount: 100,
  });
  assert.equal(isAwaitingMoreShipments(o, NOW), true);
});

test('empty trackingValues JSON counts as 0', () => {
  const o = order({
    trackingNumbers: 'AAA111',
    trackingValues: '{}',
    salePrice: 500,
    bgPaidAmount: 100,
  });
  assert.equal(isAwaitingMoreShipments(o, NOW), true);
});

test('trackingNumbers whitespace-only returns false (guard 1)', () => {
  const o = order({
    trackingNumbers: '   \t  ',
    salePrice: 500,
    bgPaidAmount: 100,
  });
  assert.equal(isAwaitingMoreShipments(o, NOW), false);
});

test('expected <= 0 returns false (guard 3)', () => {
  const o = order({
    trackingNumbers: 'AAA111',
    salePrice: 0,
    bgExpectedPayout: 0,
    bgPaidAmount: 100,
  });
  assert.equal(isAwaitingMoreShipments(o, NOW), false);
});

test('expected 0 with null salePrice and bgExpectedPayout returns false', () => {
  const o = order({
    trackingNumbers: 'AAA111',
  });
  assert.equal(isAwaitingMoreShipments(o, NOW), false);
});

test('full example from TASK.md: 2 of 3 packages, salePrice 899.91, shortfall', () => {
  const o = order({
    orderNumber: '975-1234567-8901234',
    trackingNumbers: 'TRACK1,TRACK2',
    trackingValues: JSON.stringify({ TRACK1: 400, TRACK2: 200 }),
    salePrice: 899.91,
    bgExpectedPayout: 899.91,
    bgPaidAmount: 600,
  });
  // expected = 899.91, received = 600 (bgPaidAmount > sum of trackingValues = 600)
  // threshold = 899.91 - max(1, 899.91 * 0.01) = 899.91 - 9 = 890.91
  // 600 < 890.91, so true
  assert.equal(isAwaitingMoreShipments(o, NOW), true);
});
