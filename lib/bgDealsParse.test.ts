import test from 'node:test';
import assert from 'node:assert/strict';
import { bgDealsForm, parseBgDeals } from './bgDealsParse.ts';

test('form fields match the web app', () => {
  assert.deepEqual(bgDealsForm({ page: 2, pageSize: 50, dataType: 'all', title: ' tv ' }),
    { mode: 'page', page_num: '2', page_size: '50', data_type: 'all', buyer_view: 'true', title: 'tv' });
  assert.equal(bgDealsForm().data_type, 'active');
});

test('new shape: payload.items with pagination', () => {
  const r = parseBgDeals({ status: 'SUCCESS', payload: { items: [{ deal_id: 'DL-1' }], pagination: { page_num: 1, page_size: 5, total_pages: 17, total_items: 82 } } });
  assert.deepEqual(r, { results: [{ deal_id: 'DL-1' }], count: 82 });
});

test('old shape and junk', () => {
  assert.deepEqual(parseBgDeals({ payload: { deals: [{ a: 1 }, { a: 2 }], count: 9 } }), { results: [{ a: 1 }, { a: 2 }], count: 9 });
  assert.deepEqual(parseBgDeals({ payload: { deals: [{ a: 1 }] } }), { results: [{ a: 1 }], count: 1 });
  assert.deepEqual(parseBgDeals(null), { results: [], count: 0 });
  assert.deepEqual(parseBgDeals('x'), { results: [], count: 0 });
});
