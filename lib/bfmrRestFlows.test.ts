import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RestNotSubmittedError,
  planReservationShipments,
  submitReservationRest,
  reconcileReservationRest,
  findMissingRestId,
  planOrderNumberPush,
  pushOrderNumberRest,
  planBulkShipments,
  pushTrackingRest,
} from './bfmrRestFlows.ts';

function fakeFetch(responses: Array<{ ok: boolean; status: number; body: any }>) {
  const calls: Array<{ url: string; init: { method?: string; headers?: Record<string, string>; body?: string } }> = [];
  let i = 0;
  const fetchImpl = async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
    calls.push({ url, init: { ...init } });
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    return { ok: r.ok, status: r.status, json: async () => r.body, text: async () => JSON.stringify(r.body) };
  };
  return { fetchImpl, calls };
}

const CRED = { apiKey: 'k', apiSecret: 's' };
const RES = { reserveId: 'R1', purchaseId: 'P1', bfmrOrderId: '111-1' };
const post = (valid: unknown[], invalid: unknown[]) => ({
  ok: true, status: 200, body: { reservations_response: { valid_items: valid, invalid_items: invalid } },
});

test('plan: one row', () => {
  const rows = planReservationShipments(RES, [{ qty: 2, trackingNumber: 'TBA1234567' }]);
  assert.deepEqual(rows, [
    { reserve_id: 'R1', purchase_id: 'P1', shipment_id: null, order_no: '111-1', tracking_number: 'TBA1234567', qty: 2 },
  ]);
  assert.equal('order_id' in rows[0], false);
});

test('plan: two rows, two trackings', () => {
  const rows = planReservationShipments(RES, [
    { qty: 1, trackingNumber: 'AAA11111' },
    { qty: 1, trackingNumber: 'BBB22222' },
  ]);
  assert.deepEqual(rows.map((r) => r.tracking_number), ['AAA11111', 'BBB22222']);
});

test('plan: case-variant trackings merge by summing qty', () => {
  const rows = planReservationShipments(RES, [
    { qty: 1, trackingNumber: 'TBA1' },
    { qty: 2, trackingNumber: 'tba1' },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].qty, 3);
});

test('plan: missing purchaseId throws RestNotSubmittedError', () => {
  assert.throws(
    () => planReservationShipments({ ...RES, purchaseId: null }, [{ qty: 1, trackingNumber: 'TBA1' }]),
    (e: unknown) => RestNotSubmittedError.is(e) && /no purchaseId/.test((e as Error).message) && !(e instanceof TypeError),
  );
});

test('plan: builder error is wrapped', () => {
  assert.throws(
    () => planReservationShipments(RES, [{ qty: 0, trackingNumber: 'TBA1' }]),
    (e: unknown) => RestNotSubmittedError.is(e),
  );
});

test('submit: invalid only -> RestNotSubmittedError', async () => {
  const { fetchImpl } = fakeFetch([post([], [{ error: 'bad' }])]);
  await assert.rejects(
    submitReservationRest(fetchImpl, CRED, RES, [{ qty: 1, trackingNumber: 'TBA1' }]),
    (e: unknown) => RestNotSubmittedError.is(e) && /BFMR rejected/.test((e as Error).message),
  );
});

test('submit: valid+invalid -> partially accepted, not RestNotSubmittedError', async () => {
  const { fetchImpl } = fakeFetch([post([{ ok: 1 }], [{ error: 'bad' }])]);
  await assert.rejects(
    submitReservationRest(fetchImpl, CRED, RES, [{ qty: 1, trackingNumber: 'TBA1' }]),
    (e: unknown) => !RestNotSubmittedError.is(e) && /partially accepted/.test((e as Error).message),
  );
});

test('submit: valid resolves with 1 call and planned body', async () => {
  const { fetchImpl, calls } = fakeFetch([post([{ ok: 1 }], [])]);
  const rows = [{ qty: 2, trackingNumber: 'TBA1' }];
  const out = await submitReservationRest(fetchImpl, CRED, RES, rows);
  assert.equal(out.valid.length, 1);
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(calls[0].init.body!).tracker_data, planReservationShipments(RES, rows));
});

test('submit: missing reserveId makes 0 fetch calls', async () => {
  const { fetchImpl, calls } = fakeFetch([post([], [])]);
  await assert.rejects(
    submitReservationRest(fetchImpl, CRED, { ...RES, reserveId: null }, [{ qty: 1, trackingNumber: 'TBA1' }]),
    (e: unknown) => RestNotSubmittedError.is(e),
  );
  assert.equal(calls.length, 0);
});

test('reconcile: mismatch after exactly 1 GET', async () => {
  const { fetchImpl, calls } = fakeFetch([
    { ok: true, status: 200, body: { my_tracker: [{ reserve_id: 'R1', purchase_id: 'P1', tracking_number: 'OTHER999' }] } },
  ]);
  const out = await reconcileReservationRest(fetchImpl, CRED, RES, 'TBA1');
  assert.equal(out.verdict, 'mismatch');
  assert.equal(calls.length, 1);
});

test('reconcile: case-variant tracking is ok', async () => {
  const { fetchImpl } = fakeFetch([
    { ok: true, status: 200, body: { my_tracker: [{ reserve_id: 'R1', purchase_id: 'P1', tracking_number: '1z99' }] } },
  ]);
  const out = await reconcileReservationRest(fetchImpl, CRED, RES, '1Z99');
  assert.equal(out.verdict, 'ok');
});

test('order push: create (purchaseId null) -> purchase_id null, qty number', () => {
  const { row } = planOrderNumberPush({ reserveId: 'R1', purchaseId: null, qty: 3 }, 3, '111-1');
  assert.equal(row.purchase_id, null);
  assert.equal(typeof row.qty, 'number');
  assert.equal(row.order_no, '111-1');
});

test('order push: update (purchaseId set) keeps purchase_id', () => {
  const { row } = planOrderNumberPush({ reserveId: 'R1', purchaseId: 'P9', qty: 3 }, 3, '111-1');
  assert.equal(row.purchase_id, 'P9');
});

test('order push: split flag', () => {
  const res = { reserveId: 'R1', purchaseId: null, qty: 3 };
  assert.equal(planOrderNumberPush(res, 2, '111-1').split, true);
  assert.equal(planOrderNumberPush(res, 3, '111-1').split, false);
});

test('order push: quantity over reservation qty throws, 0 fetch', async () => {
  const { fetchImpl, calls } = fakeFetch([post([{ ok: 1 }], [])]);
  await assert.rejects(
    pushOrderNumberRest(fetchImpl, CRED, { reserveId: 'R1', purchaseId: null, qty: 3 }, 4, '111-1'),
    /exceeds/,
  );
  assert.equal(calls.length, 0);
});

test('order push: dry run makes 0 fetch calls', async () => {
  const { fetchImpl, calls } = fakeFetch([post([{ ok: 1 }], [])]);
  const out = await pushOrderNumberRest(fetchImpl, CRED, { reserveId: 'R1', purchaseId: null, qty: 3 }, 2, '111-1', { dryRun: true });
  assert.equal(calls.length, 0);
  assert.equal(out.dryRun, true);
  assert.equal(out.split, true);
  assert.equal(out.bfmrQty, 3);
});

test('order push: real push POSTs once; invalid item throws BFMR rejected', async () => {
  const ok = fakeFetch([post([{ ok: 1 }], [])]);
  await pushOrderNumberRest(ok.fetchImpl, CRED, { reserveId: 'R1', purchaseId: null, qty: 3 }, 3, '111-1');
  assert.equal(ok.calls.length, 1);
  const bad = fakeFetch([post([], [{ e: 1 }])]);
  await assert.rejects(
    pushOrderNumberRest(bad.fetchImpl, CRED, { reserveId: 'R1', purchaseId: null, qty: 3 }, 3, '111-1'),
    /BFMR rejected/,
  );
});

const trow = (o: string, n: number, over: Record<string, unknown> = {}) => ({
  order_id: o, reserve_id: `R${o}${n}`, purchase_id: `P${o}${n}`, qty: 1, tracking_number: '', ...over,
});

test('bulk: two orders, one row each -> 2 rows', () => {
  const { rows, attributions } = planBulkShipments(
    [trow('A', 1), trow('B', 1)],
    { A: ['TBA1'], B: ['TBA2'] },
  );
  assert.equal(rows.length, 2);
  assert.equal(attributions.length, 2);
  assert.equal(rows[0].order_no, 'A');
});

test('bulk: order with 2 rows and 2 trackings -> distinct trackings', () => {
  const { rows } = planBulkShipments([trow('A', 1), trow('A', 2)], { A: ['TBA1', 'TBA2'] });
  assert.deepEqual(rows.map((r) => r.tracking_number), ['TBA1', 'TBA2']);
});

test('bulk: row already has tba1, map has TBA1 -> 0 rows', () => {
  const { rows } = planBulkShipments([trow('A', 1, { tracking_number: 'tba1' })], { A: ['TBA1'] });
  assert.equal(rows.length, 0);
});

test('bulk: tracking on a sibling row is not re-sent (case-insensitive)', () => {
  const { rows } = planBulkShipments(
    [trow('A', 1, { tracking_number: 'tba1' }), trow('A', 2)],
    { A: ['TBA1'] },
  );
  assert.equal(rows.length, 0);
});

test('bulk: row with no purchase_id is skipped', () => {
  const { rows } = planBulkShipments([trow('A', 1, { purchase_id: null })], { A: ['TBA1'] });
  assert.equal(rows.length, 0);
});

test('bulk: 120 orders -> 3 GETs, each <=50 orders[]', async () => {
  const map: Record<string, string[]> = {};
  for (let i = 0; i < 120; i++) map[`O${i}`] = ['TBA' + i];
  const { fetchImpl, calls } = fakeFetch([{ ok: true, status: 200, body: { my_tracker: [] } }]);
  const out = await pushTrackingRest(fetchImpl, CRED, map);
  assert.equal(out.length, 0);
  assert.equal(calls.length, 3);
  for (const c of calls) {
    assert.equal(c.init.method, 'GET');
    const n = new URL(c.url).searchParams.getAll('orders[]').length;
    assert.ok(n <= 50 && n > 0);
  }
});

test('bulk: 0 planned rows -> no POST', async () => {
  const { fetchImpl, calls } = fakeFetch([{ ok: true, status: 200, body: { my_tracker: [trow('A', 1, { tracking_number: 'TBA1' })] } }]);
  await pushTrackingRest(fetchImpl, CRED, { A: ['tba1'] });
  assert.equal(calls.filter((c) => c.init.method === 'POST').length, 0);
});

test('bulk: POSTs planned rows and returns valid attributions', async () => {
  const { fetchImpl, calls } = fakeFetch([
    { ok: true, status: 200, body: { my_tracker: [trow('A', 1), trow('A', 2)] } },
    post([{ reserve_id: 'RA1', purchase_id: 'PA1' }], [{ reserve_id: 'RA2', purchase_id: 'PA2' }]),
  ]);
  const out = await pushTrackingRest(fetchImpl, CRED, { A: ['TBA1', 'TBA2'] });
  assert.equal(calls.length, 2);
  assert.deepEqual(out.map((a) => a.reserveId), ['RA1']);
});

test('findMissingRestId: check order', () => {
  assert.equal(findMissingRestId({ reserveId: null, purchaseId: null, bfmrOrderId: null }), 'bfmrOrderId');
  assert.equal(findMissingRestId({ reserveId: null, purchaseId: null, bfmrOrderId: 'x' }), 'reserveId');
  assert.equal(findMissingRestId({ reserveId: 'r', purchaseId: null, bfmrOrderId: 'x' }), 'purchaseId');
  assert.equal(findMissingRestId({ reserveId: 'r', purchaseId: 'p', bfmrOrderId: 'x' }), null);
});
