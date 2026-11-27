import test from 'node:test';
import assert from 'node:assert/strict';
import { bfmrEntry, bfmrEntryFor, bgEntry } from './crossGroupSources.ts';
import { computeFlags } from './crossGroup.ts';

test('bfmr entry carries slug, payout, upcs and models from items', () => {
  const e = bfmrEntry({ slug: 'airpods', title: 'AirPods', value: '129.50' }, [{ upc: ['194253397601'], model: 'MTJV3AM/A' }, { upc: ['194253397602'] }]);
  assert.equal(e.id, 'airpods');
  assert.equal(e.payout, 129.5);
  assert.deepEqual(e.upcs, ['194253397601', '194253397602']);
  assert.deepEqual(e.models, ['MTJV3AM/A']);
  assert.equal(e.href, '/bfmr/deals?focus=airpods');
});

test('bg entry pays price plus commission', () => {
  const e = bgEntry({ key: 'k-1', title: 'Apple-AirPods', commission: '140.00', price: '99', deal_item: [{ upc: '194253397601', item_model: 'MTJV3AM/A' }, { key: 'x' }] });
  assert.ok(e);
  assert.equal(e.payout, 239);
  assert.equal(e.title, 'Apple AirPods');
  assert.deepEqual(e.upcs, ['194253397601']);
  assert.deepEqual(e.models, ['MTJV3AM/A']);
});

test('bg entry without a key or upc fields is harmless', () => {
  assert.equal(bgEntry({ title: 'x' }), null);
  const e = bgEntry({ key: 'k', title: 't', commission: '5', price: '10', deal_item: null });
  assert.deepEqual(e?.upcs, []);
});

test('bfmr and bg entries flag each other end to end', () => {
  const b = bfmrEntry({ slug: 's', title: 'a', value: '100' }, [{ upc: ['0194253397601'] }]);
  const g = bgEntry({ key: 'k', title: 'a', price: '0', commission: '115', deal_item: [{ upc: '194253397601' }] })!;
  const f = computeFlags([b, g]);
  assert.equal(f['bfmr:s'].diff, 15);
  assert.equal(f['bfmr:s'].href, '/buyinggroup/deals?focus=k');
});

test('unparseable payouts never flag', () => {
  const b = bfmrEntry({ slug: 's', title: 'a', value: 'abc' }, [{ upc: ['194253397601'] }]);
  const g = bgEntry({ key: 'k', title: 'a', price: '0', commission: '115', upc: '194253397601' })!;
  assert.deepEqual(computeFlags([b, g]), {});
});

test('bg payout is price plus the per-unit commission (price 599, commission 2)', () => {
  const e = bgEntry({ key: 'k', title: 't', price: '599.00', commission: '2.00' });
  assert.equal(e?.payout, 601);
});

test('bg entry reads upc and model from commitment items', () => {
  const e = bgEntry({ key: 'k', title: 't', price: '10', commission: '1' }, [{ upc: '194253397601', item_model: 'MTJV3AM/A' }]);
  assert.deepEqual(e?.upcs, ['194253397601']);
  assert.deepEqual(e?.models, ['MTJV3AM/A']);
});

test('a bfmr bundle deal is never indexed by its component upcs', () => {
  const deal = { slug: 's', title: 'Bundle', value: '50' };
  assert.equal(bfmrEntryFor(deal, { is_bundle: true, items: [{ upc: ['194253397601'] }] }), null);
  assert.deepEqual(bfmrEntryFor(deal, { is_bundle: false, items: [{ upc: ['194253397601'] }] })?.upcs, ['194253397601']);
});
