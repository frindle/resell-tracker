import test from 'node:test';
import assert from 'node:assert/strict';
import { restDealItems, restItemToWeb } from './bfmrDealItems.ts';

test('a list of items passes through', () => {
  const list = [{ id: '7', name: 'Console', upc: ['0123'], retailer_links: [{ retailer: 'Target', url: 'u', identifier_id: 'x' }] }];
  assert.deepEqual(restDealItems(list), list);
  assert.deepEqual(restItemToWeb(restDealItems(list)[0], true).links, [{ vendor_name: 'Target', in_stock: true, link_url: 'u', identifier: 'x' }]);
});

test('one item object: its nested items are the retailer links, with their own stock', () => {
  const one = { id: '9', name: 'Laptop', model: 'M1', upc: ['0456'], items: [
    { retailer: 'Best Buy', identifier_id: 'b', url: 'ub', in_stock: false },
    { retailer: 'Amazon', identifier_id: 'a', url: 'ua', in_stock: true },
  ] };
  const [it] = restDealItems(one);
  assert.equal(it.model, 'M1');
  assert.deepEqual(it.upc, ['0456']);
  const web = restItemToWeb(it, true);
  assert.equal(web.item_id, 9);
  assert.deepEqual(web.links?.map(l => [l.vendor_name, l.in_stock]), [['Best Buy', false], ['Amazon', true]]);
});

test('missing or odd items: empty list', () => {
  assert.deepEqual(restDealItems(undefined), []);
  assert.deepEqual(restDealItems(null), []);
  assert.deepEqual(restDealItems('x'), []);
  assert.deepEqual(restDealItems({ id: '1' }), [{ id: '1', retailer_links: [] }]);
});
