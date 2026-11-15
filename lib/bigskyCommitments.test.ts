import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFulfillmentRows, attachScanTracking, trackingKey, sameTracking, ordersForTracking } from './bigskyCommitments.ts';

const row = (over: Record<string, unknown> = {}) => ({
  commitmentId: 'c1',
  dealId: 'd1',
  itemName: 'Widget',
  itemUpc: '012345678905',
  dealPrice: '199.99',
  commitmentAmount: 3,
  fulfilled: 2,
  commitmentsRemaining: 1,
  fulfillmentPercentage: 66.7,
  status: 'UNFULFILLED',
  dealCreated: '2026-10-01T00:00:00.000Z',
  dealExpiration: '2026-11-30T00:00:00.000Z',
  creationDate: '2026-10-02T12:00:00.000Z',
  fulfillmentDate: null,
  fulfillmentDetails: [
    { id: 'f1', quantity: 1, date: '2026-10-10T18:30:00.123Z', scanId: 's1' },
    { id: 'f2', quantity: 1, date: '2026-10-11T09:00:00.000Z', scanId: 's2' },
  ],
  ...over,
});

test('parses a BigSky row: string price to number, ISO dates, details', () => {
  const { rows, skipped } = parseFulfillmentRows([row()]);
  assert.equal(skipped, 0);
  const r = rows[0];
  assert.equal(r.dealPrice, 199.99);
  assert.equal(r.commitmentAmount, 3);
  assert.equal(r.fulfilled, 2);
  assert.equal(r.commitmentsRemaining, 1);
  assert.equal(r.status, 'UNFULFILLED');
  assert.equal(r.dealExpiration?.toISOString(), '2026-11-30T00:00:00.000Z');
  assert.equal(r.fulfillmentDate, null);
  assert.deepEqual(r.fulfillments.map(f => [f.id, f.quantity, f.scanId]), [['f1', 1, 's1'], ['f2', 1, 's2']]);
  assert.deepEqual(r.fulfillments[0].trackingNumbers, []);
});

test('keeps commitmentsRemaining as BigSky reports it, even when it is not amount - fulfilled', () => {
  const { rows } = parseFulfillmentRows([row({ commitmentAmount: 5, fulfilled: 1, commitmentsRemaining: 0 })]);
  assert.equal(rows[0].commitmentsRemaining, 0);
  const missing = parseFulfillmentRows([row({ commitmentAmount: 5, fulfilled: 1, commitmentsRemaining: undefined })]);
  assert.equal(missing.rows[0].commitmentsRemaining, 4);
});

test('skips rows missing an id, deal, price or counts instead of storing them half-filled', () => {
  const bad = [row({ commitmentId: '' }), row({ dealId: null }), row({ dealPrice: 'n/a' }), row({ commitmentAmount: undefined }), row({ fulfilled: null }), null, 'x'];
  const { rows, skipped } = parseFulfillmentRows([row(), ...bad]);
  assert.equal(rows.length, 1);
  assert.equal(skipped, bad.length);
});

test('drops fulfillment details without a quantity or date; missing details is an empty list', () => {
  const { rows } = parseFulfillmentRows([
    row({ fulfillmentDetails: [{ id: 'a', quantity: 1, date: 'not a date' }, { id: 'b', date: '2026-10-10T00:00:00Z' }, { id: 'c', quantity: 2, date: '2026-10-10T00:00:00Z' }] }),
    row({ commitmentId: 'c2', fulfillmentDetails: undefined }),
  ]);
  assert.deepEqual(rows[0].fulfillments.map(f => f.id), ['c']);
  assert.deepEqual(rows[1].fulfillments, []);
});

test('a fulfillment gets the tracking of the scan with its UPC and exact scan time', () => {
  const { rows } = parseFulfillmentRows([row()]);
  const out = attachScanTracking(rows, [
    { trackingNumber: '1Z999AA10123456784', itemUpc: '012345678905', scanDate: '2026-10-10T18:30:00.123Z' },
    // Same instant, other UPC: not this commitment's scan.
    { trackingNumber: '1Z999AA10000000001', itemUpc: '999999999999', scanDate: '2026-10-10T18:30:00.123Z' },
    // Same UPC, one millisecond off: not this fulfillment's scan.
    { trackingNumber: '1Z999AA10000000002', itemUpc: '012345678905', scanDate: '2026-10-10T18:30:00.124Z' },
  ]);
  assert.deepEqual(out[0].fulfillments[0].trackingNumbers, ['1Z999AA10123456784']);
  assert.deepEqual(out[0].fulfillments[1].trackingNumbers, []);
  // The input rows are not changed.
  assert.deepEqual(rows[0].fulfillments[0].trackingNumbers, []);
});

test('boxes of one UPC scanned in the same instant all match, each tracking number once', () => {
  const { rows } = parseFulfillmentRows([row()]);
  const at = '2026-10-10T18:30:00.123Z';
  const out = attachScanTracking(rows, [
    { trackingNumber: 'TRACKAAAA0001', itemUpc: '012345678905', scanDate: at },
    { trackingNumber: 'TRACKAAAA0002', itemUpc: '012345678905', scanDate: at },
    { trackingNumber: 'TRACKAAAA0001', itemUpc: '012345678905', scanDate: at },
    { trackingNumber: '', itemUpc: '012345678905', scanDate: at },
  ]);
  assert.deepEqual(out[0].fulfillments[0].trackingNumbers, ['TRACKAAAA0001', 'TRACKAAAA0002']);
});

test('non-numeric item codes match the same way', () => {
  const { rows } = parseFulfillmentRows([row({ itemUpc: 'BSB-XYZ-01' })]);
  const out = attachScanTracking(rows, [{ trackingNumber: 'TRACKBBBB0001', itemUpc: 'BSB-XYZ-01', scanDate: '2026-10-10T18:30:00.123Z' }]);
  assert.deepEqual(out[0].fulfillments[0].trackingNumbers, ['TRACKBBBB0001']);
});

test('trackingKey keeps letters and digits, upper case', () => {
  assert.equal(trackingKey(' 1z 999-aa1 '), '1Z999AA1');
  assert.equal(trackingKey(null as unknown as string), '');
});

test('sameTracking: equal, or a 12+ character number at the end of a longer one', () => {
  assert.ok(sameTracking('9400111899223344556677', '9400 1118 9922 3344 5566 77'));
  // USPS barcode: 420 + ZIP in front.
  assert.ok(sameTracking('420891019400111899223344556677', '9400111899223344556677'));
  assert.ok(!sameTracking('42089101123456789012', '123456789012'.slice(1)));
  assert.ok(!sameTracking('', ''));
  assert.ok(!sameTracking('ABC', 'XABC'));
});

test('ordersForTracking finds orders carrying any of the numbers, in order', () => {
  const orders = [
    { id: 1, trackingNumbers: '1Z999AA10123456784' },
    { id: 2, trackingNumbers: null },
    { id: 3, trackingNumbers: 'OTHER00000001, 420891019400111899223344556677' },
    { id: 4, trackingNumbers: 'OTHER00000002' },
  ];
  assert.deepEqual(ordersForTracking(orders, ['9400111899223344556677', '1z999aa10123456784']).map(o => o.id), [1, 3]);
  assert.deepEqual(ordersForTracking(orders, []), []);
});
