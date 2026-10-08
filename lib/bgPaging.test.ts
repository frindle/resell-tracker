import test from 'node:test';
import assert from 'node:assert/strict';
import { bgPageAll } from './bgPaging.ts';

const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ receipt_id: i + 1 }));
const id = (r: { receipt_id: number }) => String(r.receipt_id);

test('BG ignores page_size (25/page): all 60 rows fetched, not just the first 25', async () => {
  const all = rows(60);
  const calls: number[] = [];
  const out = await bgPageAll(async (p) => { calls.push(p); return { payload: { receipts: all.slice((p - 1) * 25, p * 25), pages: 3 } }; }, 'receipts', id);
  assert.equal(out.length, 60);
  assert.deepEqual(calls, [1, 2, 3]);
});
test('no pages field: continues past a short page until empty', async () => {
  const all = rows(30);
  const out = await bgPageAll(async (p) => ({ payload: { orders: all.slice((p - 1) * 25, p * 25) } }), 'orders', id);
  assert.equal(out.length, 30);
});
test('endpoint ignoring page (repeats page 1) stops instead of looping', async () => {
  let n = 0;
  const out = await bgPageAll(async () => { n++; return { payload: { receipts: rows(25) } }; }, 'receipts', id);
  assert.equal(out.length, 25);
  assert.equal(n, 2);
});
test('empty first page and legacy shapes', async () => {
  assert.deepEqual(await bgPageAll(async () => ({ payload: { receipts: [] } }), 'receipts', id), []);
  assert.equal((await bgPageAll(async (p) => (p === 1 ? rows(3) : []), 'receipts', id)).length, 3);
  assert.equal((await bgPageAll(async (p) => ({ results: p === 1 ? rows(2) : [] }), 'receipts', id)).length, 2);
});
