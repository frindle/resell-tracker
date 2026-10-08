import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCommitmentsResponse } from './bgCommitmentsResponse.ts';

test('invalid-payload error describes the shape (keys + types) without values', () => {
  assert.throws(() => parseCommitmentsResponse({ status: 'SUCCESS', payload: { items: [{ secret: 'x' }], total: 5 } }),
    (e: Error) => /payload:\{items:array\(1\),total:number\}/.test(e.message) && !/secret|"x"/.test(e.message));
});
test('SUCCESS with empty array returns empty, not an error', () => {
  assert.deepEqual(parseCommitmentsResponse({ status: 'SUCCESS', message: '', payload: { commitments: [], count: 0 } }), { commitments: [], count: 0 });
});
test('SUCCESS with rows returns them and count', () => {
  assert.deepEqual(parseCommitmentsResponse({ status: 'SUCCESS', payload: { commitments: [{ a: 1 }], count: 7 } }), { commitments: [{ a: 1 }], count: 7 });
});
test('missing status with valid payload is accepted; missing count defaults to 0', () => {
  assert.deepEqual(parseCommitmentsResponse({ payload: { commitments: [] } }), { commitments: [], count: 0 });
});
test('non-SUCCESS status throws naming endpoint, status and message', () => {
  assert.throws(() => parseCommitmentsResponse({ status: 'ERROR', message: 'token expired', payload: { commitments: [] } }),
    (e: Error) => /\/commitment\/get_commitments/.test(e.message) && /ERROR/.test(e.message) && /token expired/.test(e.message));
});
test('missing payload / non-array commitments / non-object body throw', () => {
  assert.throws(() => parseCommitmentsResponse({ status: 'SUCCESS' }), /invalid payload/);
  assert.throws(() => parseCommitmentsResponse({ status: 'SUCCESS', payload: { commitments: null } }), /invalid payload/);
  assert.throws(() => parseCommitmentsResponse({ status: 'SUCCESS', payload: null }), /invalid payload/);
  assert.throws(() => parseCommitmentsResponse(null), /invalid payload/);
});
