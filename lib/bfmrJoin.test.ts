// Web backfill: a tie of more than one 1:1 bfmrJoinKey hit is broken by the row's own tracking number.
//
// Live case (2026-11-03): an Onn 55SQ4GSB1 commitment came back as three qty-1 rows under order 200015089230039, all
// reserved at 10/07/2026 20:06:01. All three share one bfmrJoinKey, so every half hit every web row and was stamped
// ambiguous; local rows 374541 (tracking 542056534601) and 374543 (tracking 542056534586) kept myTrackerId null after
// every sync. Only the tracking number tells the rows apart. Fixtures mirror that shape; the tracker ids are made up.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeBackfillLocal, resolveTrackerBackfill } from './bfmrJoin.ts';

const ORDER = '200015089230039';
// One web row per half: identical join key, distinct tracking number and tracker id.
const WEB_KEY = { reserved_at: '2026-10-07 20:06:01', item_model_number: '55SQ4GSB1', qty: '1', order_id: ORDER };
const WEB_601 = { ...WEB_KEY, tracking_number: '542056534601', my_tracker_id: 7000601 };
const WEB_597 = { ...WEB_KEY, tracking_number: '542056534597', my_tracker_id: 7000597 };
const WEB_586 = { ...WEB_KEY, tracking_number: '542056534586', my_tracker_id: 7000586 };
const WEB = [WEB_601, WEB_597, WEB_586];

// A local row exactly as the sync route hands it over: the REST item's JSON in `raw`, the order id from its column.
function local(id: number, tracking?: unknown, order: string = ORDER) {
  const item: Record<string, unknown> = {
    reserved_at: '10/07/2026 20:06:01', item_model_number: '55SQ4GSB1', item_name: 'onn. 55in QLED 4K', qty: '1', order_id: order,
  };
  if (tracking !== undefined) item.tracking_number = tracking;
  return normalizeBackfillLocal({ id, raw: JSON.stringify(item), itemName: 'onn. 55in QLED 4K', qty: 1, bfmrOrderId: order });
}

const byId = (a: Array<{ id: number; myTrackerId: number }>) => [...a].sort((x, y) => x.id - y.id);

test('normalize carries the raw tracking number', () => {
  const n = local(374541, '542056534601');
  assert.equal(n.tracking_number, '542056534601');
  // the rest of the row is unchanged
  assert.equal(n.id, 374541);
  assert.equal(n.reserved_at, '10/07/2026 20:06:01');
  assert.equal(n.order_id, ORDER);
  // the value is passed through as stored, not reformatted (the resolver normalizes)
  assert.equal(local(1, ' 1z999aa1 ').tracking_number, ' 1z999aa1 ');
  // a raw item without the field, and an absent, empty or unparseable raw: undefined, never a throw
  assert.equal(local(2).tracking_number, undefined);
  for (const raw of [null, undefined, '', '{not json']) {
    const m = normalizeBackfillLocal({ id: 3, raw: raw as string | null, itemName: 'fallback', qty: 1, bfmrOrderId: null });
    assert.equal(m.tracking_number, undefined, `raw ${JSON.stringify(raw)}`);
    assert.equal(m.item_name, 'fallback');
  }
});

test('THE BUG: split halves on one order resolve by tracking number', () => {
  const r = resolveTrackerBackfill([local(374541, '542056534601'), local(374543, '542056534586')], WEB);
  assert.deepEqual(byId(r.matchedUpdates), [
    { id: 374541, myTrackerId: 7000601 },
    { id: 374543, myTrackerId: 7000586 },
  ]);
  // resolved rows are not also stamped, counted ambiguous, or handed to the split pass
  assert.deepEqual(r.stampIds, []);
  assert.deepEqual(r.counts, { backfilled: 2, ambiguous: 0, unmatched: 0 });
  // the order of the web rows does not matter
  const rev = resolveTrackerBackfill([local(374543, '542056534586')], [...WEB].reverse());
  assert.deepEqual(rev.matchedUpdates, [{ id: 374543, myTrackerId: 7000586 }]);
});

test('REFUSES TO GUESS: a tie the tracking number cannot break stays ambiguous', () => {
  // control: this exact tie IS broken when the tracking number picks one row, so each refusal below is for its stated reason
  assert.deepEqual(resolveTrackerBackfill([local(9, '542056534597')], WEB).matchedUpdates, [{ id: 9, myTrackerId: 7000597 }]);
  const refused = (label: string, row: ReturnType<typeof local>, web: Array<Record<string, unknown>>) => {
    const r = resolveTrackerBackfill([row], web);
    assert.deepEqual(r.matchedUpdates, [], `${label}: must not resolve`);
    assert.deepEqual(r.stampIds, [row.id], `${label}: must be stamped`);
    assert.deepEqual(r.counts, { backfilled: 0, ambiguous: 1, unmatched: 0 }, `${label}: must count as ambiguous`);
  };
  // the local row has no usable tracking number
  refused('no tracking number', local(10), WEB);
  refused('null tracking number', local(11, null), WEB);
  refused('empty tracking number', local(12, ''), WEB);
  refused('blank tracking number', local(13, '   '), WEB);
  // an empty or missing tracking number never matches a hit that has none either
  refused('empty against a hit with an empty one', local(14, ''), [WEB_601, { ...WEB_597, tracking_number: '' }, WEB_586]);
  refused('missing against a hit without one', local(15), [WEB_601, { ...WEB_KEY, my_tracker_id: 7000597 }, WEB_586]);
  // the tracking number picks none of the hits
  refused('tracking matches no hit', local(16, '999999999999'), WEB);
  // the tracking number picks more than one hit
  refused('tracking matches two hits', local(17, '542056534601'), [WEB_601, { ...WEB_597, tracking_number: '542056534601' }, WEB_586]);
  // the one hit it picks has no usable tracker id
  for (const bad of [null, undefined, 0, '', 'abc', -5]) {
    refused(`picked hit with my_tracker_id ${String(bad)}`, local(18, '542056534601'),
      [{ ...WEB_601, my_tracker_id: bad }, WEB_597, WEB_586]);
  }
});

test('tracking breaks a tie only among rows that share the 1:1 key', () => {
  // control: the row resolves when its key ties the three web rows
  assert.deepEqual(resolveTrackerBackfill([local(20, '542056534601')], WEB).matchedUpdates, [{ id: 20, myTrackerId: 7000601 }]);
  // same tracking number under another order (no key hit): no tracking-only match, the row stays unmatched
  const r1 = resolveTrackerBackfill([local(21, '542056534601', 'OTHER-ORDER')], WEB);
  assert.deepEqual(r1.matchedUpdates, []);
  assert.deepEqual(r1.counts, { backfilled: 0, ambiguous: 0, unmatched: 1 });
  // a tie on the key whose tracking number only matches a web row OUTSIDE the key stays ambiguous
  const elsewhere = { ...WEB_601, order_id: 'OTHER-ORDER', my_tracker_id: 7999999 };
  const r2 = resolveTrackerBackfill([local(22, '542056534601')], [elsewhere, WEB_597, WEB_586]);
  assert.deepEqual(r2.matchedUpdates, []);
  assert.deepEqual(r2.counts, { backfilled: 0, ambiguous: 1, unmatched: 0 });
  // exactly one key hit still matches as before, even when its tracking number differs
  const r3 = resolveTrackerBackfill([local(23, '542056534601')], [WEB_586]);
  assert.deepEqual(r3.matchedUpdates, [{ id: 23, myTrackerId: 7000586 }]);
});

test('tracking numbers compare without whitespace and case', () => {
  const web = [
    { ...WEB_KEY, tracking_number: '1Z999AA10123456784', my_tracker_id: 7100001 },
    { ...WEB_KEY, tracking_number: '1Z999AA10123456785', my_tracker_id: 7100002 },
  ];
  const r = resolveTrackerBackfill([local(30, ' 1z999aa1 0123456784\t')], web);
  assert.deepEqual(r.matchedUpdates, [{ id: 30, myTrackerId: 7100001 }]);
  assert.deepEqual(r.stampIds, []);
  // the web side is normalized too, and a number-typed value compares as its digits
  const r2 = resolveTrackerBackfill([local(31, 542056534586)], [WEB_601, { ...WEB_586, tracking_number: ' 5420 5653 4586 ' }]);
  assert.deepEqual(r2.matchedUpdates, [{ id: 31, myTrackerId: 7000586 }]);
});
