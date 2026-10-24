import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RestNotSubmittedError,
  planReservationShipments,
  submitReservationRest,
  reconcileReservationRest,
  findMissingRestId,
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

test('findMissingRestId: check order', () => {
  assert.equal(findMissingRestId({ reserveId: null, purchaseId: null, bfmrOrderId: null }), 'bfmrOrderId');
  assert.equal(findMissingRestId({ reserveId: null, purchaseId: null, bfmrOrderId: 'x' }), 'reserveId');
  assert.equal(findMissingRestId({ reserveId: 'r', purchaseId: null, bfmrOrderId: 'x' }), 'purchaseId');
  assert.equal(findMissingRestId({ reserveId: 'r', purchaseId: 'p', bfmrOrderId: 'x' }), null);
});
