import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCommitmentsResponse } from './bgCommitmentsResponse.ts';

const row = (id: string) => ({ commitment_id: id, status: 'ACTIVE' });

test('current format: payload.items + pagination total', () => {
  const r = parseCommitmentsResponse({ status: 'SUCCESS', message: '', payload: { mode: 'x', items: [row('CM-1'), row('CM-2')], pagination: { page: 1, total: 30 } } });
  assert.deepEqual(r, { commitments: [row('CM-1'), row('CM-2')], count: 30 });
});
test('current format: total under another pagination key, or none at all', () => {
  assert.equal(parseCommitmentsResponse({ payload: { items: [row('CM-1')], pagination: { total_count: 9 } } }).count, 9);
  assert.equal(parseCommitmentsResponse({ payload: { items: [row('CM-1')], pagination: { page: 2 } } }).count, null);
});
test('rows without commitment_id throw with row + pagination shape, no values', () => {
  assert.throws(() => parseCommitmentsResponse({ status: 'SUCCESS', payload: { items: [{ secret: 'x' }], pagination: { page: 1 } } }),
    (e: Error) => /row shape: secret:string/.test(e.message) && /pagination: page:number/.test(e.message) && !/"x"/.test(e.message));
});
test('invalid-payload error describes the shape (keys + types) without values', () => {
  assert.throws(() => parseCommitmentsResponse({ status: 'SUCCESS', payload: { rows: [{ secret: 'x' }], total: 5 } }),
    (e: Error) => /payload:\{rows:array\(1\),total:number\}/.test(e.message) && !/secret|"x"/.test(e.message));
});
test('legacy: SUCCESS with empty array returns empty, not an error', () => {
  assert.deepEqual(parseCommitmentsResponse({ status: 'SUCCESS', message: '', payload: { commitments: [], count: 0 } }), { commitments: [], count: 0 });
});
test('legacy: SUCCESS with rows returns them and count', () => {
  assert.deepEqual(parseCommitmentsResponse({ status: 'SUCCESS', payload: { commitments: [row('CM-1')], count: 7 } }), { commitments: [row('CM-1')], count: 7 });
});
test('missing status with valid payload is accepted; missing count is null', () => {
  assert.deepEqual(parseCommitmentsResponse({ payload: { commitments: [] } }), { commitments: [], count: null });
});
test('non-SUCCESS status throws naming endpoint, status and message', () => {
  assert.throws(() => parseCommitmentsResponse({ status: 'ERROR', message: 'token expired', payload: { commitments: [] } }),
    (e: Error) => /\/commitment\/get_commitments/.test(e.message) && /ERROR/.test(e.message) && /token expired/.test(e.message));
});
test('missing payload / non-array list / non-object body throw', () => {
  assert.throws(() => parseCommitmentsResponse({ status: 'SUCCESS' }), /invalid payload/);
  assert.throws(() => parseCommitmentsResponse({ status: 'SUCCESS', payload: { commitments: null } }), /invalid payload/);
  assert.throws(() => parseCommitmentsResponse({ status: 'SUCCESS', payload: null }), /invalid payload/);
  assert.throws(() => parseCommitmentsResponse(null), /invalid payload/);
});
