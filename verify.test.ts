// Adversarial repo-style test for: bfmrJoin   (node --test / tsx --test)
//
// The defect: a BFMR commitment split across >1 local reservation rows never
// gets myTrackerId, so submitting tracking 409s. Order 930 (qty 5) + order 931
// (qty 3) are two halves of ONE 8-unit web row; each half matches the web row on
// neither qty nor order_id, so both stay unresolved forever.
//
// The fix must resolve the group by SUMMING the halves -- and must NOT start
// guessing when the sum is wrong or the match is ambiguous, which is the
// wrong-reservation bug this module's own header says was already paid for once.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { matchSplitGroups, bfmrJoinKey, normalizeBfmrTimestamp } from './lib/bfmrJoin';

// The live shape of the defect. reserved_at deliberately differs in FORMAT
// between the two surfaces, exactly as measured in the module header.
const RESERVED_LOCAL = '09/18/2026 14:22:31';   // REST spelling
const RESERVED_WEB = '2026-09-18 14:22:31';     // Web spelling, same instant
const ITEM = 'MX2D3AM/A';

const local = (id: number, qty: unknown, over: Record<string, unknown> = {}) => ({
  id, qty, reserved_at: RESERVED_LOCAL, item_model_number: ITEM, ...over,
});
const web = (my_tracker_id: unknown, qty: unknown, over: Record<string, unknown> = {}) => ({
  my_tracker_id, qty, reserved_at: RESERVED_WEB, item_model_number: ITEM, ...over,
});

test('the live defect: a split whose qtys SUM to one web row resolves for every half', () => {
  // order 930 (qty 5) + order 931 (qty 3) = the single 8-unit web row.
  // order_id differs per half on purpose: it is the field that legitimately
  // varies inside a split, and the whole bug is that it was load-bearing.
  const out = matchSplitGroups(
    [local(930, 5, { order_id: 'ORD-930' }), local(931, 3, { order_id: 'ORD-931' })],
    [web(4901929, 8, { order_id: null })],
  );
  assert.deepEqual(
    [...out].sort((a, b) => a.id - b.id),
    [{ id: 930, my_tracker_id: 4901929 }, { id: 931, my_tracker_id: 4901929 }],
    'both halves of the split must resolve to the one web row\'s my_tracker_id',
  );
});

test('OVER-TRIGGER GUARD: a sum that matches NOTHING stays unresolved, never guesses', () => {
  // 5 + 3 = 8, but the only web row is a 7. There is no honest match here; the
  // rows must stay null (webUnmatched) rather than being handed the nearest row.
  assert.deepEqual(
    matchSplitGroups([local(930, 5), local(931, 3)], [web(4901929, 7)]),
    [],
  );
});

test('OVER-TRIGGER GUARD: an AMBIGUOUS sum (two web rows at 8) stays unresolved', () => {
  // Two genuinely different commitments, same instant, same item, same qty are
  // indistinguishable here. Picking one is the wrong-reservation bug.
  assert.deepEqual(
    matchSplitGroups(
      [local(930, 5), local(931, 3)],
      [web(4901929, 8), web(4901930, 8)],
    ),
    [],
  );
});

test('OVER-TRIGGER GUARD: a 1:1 row is NOT claimed by the split path', () => {
  // A lone local row is the ordinary path's business. If this function also
  // claimed it, two paths would write the same column and the "exactly one
  // match" discipline would be silently doubled up.
  assert.deepEqual(matchSplitGroups([local(930, 8)], [web(4901929, 8)]), []);
});

test('rows from a DIFFERENT group are never summed together', () => {
  // Same qtys, but one half is a different item -- so there is no 2-member group
  // at all and nothing may resolve. Pins that the grouping key is real.
  assert.deepEqual(
    matchSplitGroups(
      [local(930, 5), local(931, 3, { item_model_number: 'SOMETHING-ELSE' })],
      [web(4901929, 8)],
    ),
    [],
  );
  // ...and the same for a different reserved_at.
  assert.deepEqual(
    matchSplitGroups(
      [local(930, 5), local(931, 3, { reserved_at: '09/18/2026 09:00:00' })],
      [web(4901929, 8)],
    ),
    [],
  );
});

test('a web row with no my_tracker_id cannot resolve a split', () => {
  // Matching on qty is not enough -- the whole point is to obtain a tracker id.
  assert.deepEqual(matchSplitGroups([local(930, 5), local(931, 3)], [web(null, 8)]), []);
  assert.deepEqual(matchSplitGroups([local(930, 5), local(931, 3)], [web(0, 8)]), []);
});

test('degenerate input does not throw and resolves nothing', () => {
  assert.deepEqual(matchSplitGroups([], []), []);
  assert.deepEqual(matchSplitGroups([local(930, 5), local(931, 3)], []), []);
  assert.deepEqual(matchSplitGroups([local(930, null), local(931, undefined)], [web(1, 8)]), []);
  assert.deepEqual(matchSplitGroups([local(930, 'abc'), local(931, 3)], [web(1, 8)]), []);
  // No reserved_at / item on either side: both sides degenerate to the same
  // empty group key. Whether that resolves is a judgement call the spec leaves
  // open; what must NOT happen is a throw. Assert exactly that, and no more --
  // a test that pinned an arbitrary answer here would be asserting a decision
  // the task never made.
  assert.doesNotThrow(() => matchSplitGroups(
    [{ id: 930, qty: 5 } as never, { id: 931, qty: 3 } as never],
    [{ my_tracker_id: 1, qty: 8 } as never],
  ));
  assert.ok(Array.isArray(matchSplitGroups(
    [{ id: 930, qty: 5 } as never, { id: 931, qty: 3 } as never],
    [{ my_tracker_id: 1, qty: 8 } as never],
  )));
});

test('a three-way split resolves too (the fix is not hardcoded to two halves)', () => {
  const out = matchSplitGroups(
    [local(930, 2), local(931, 3), local(932, 4)],
    [web(4901929, 9)],
  );
  assert.equal(out.length, 3);
  assert.ok(out.every(r => r.my_tracker_id === 4901929));
});

test('REGRESSION: bfmrJoinKey still keys on qty AND order_id, unchanged', () => {
  // The 1:1 path depends on this exact shape. A "fix" that loosened the shared
  // key instead of adding a second path would turn this red -- which is the
  // point: it would silently make every ambiguous 1:1 row start matching.
  const k = bfmrJoinKey({
    reserved_at: RESERVED_WEB, item_model_number: ITEM, qty: '2', order_id: 'ORD-1',
  });
  assert.equal(k, '2026-09-18T14:22:31|mx2d3am/a|2|ORD-1');
  assert.notEqual(
    k,
    bfmrJoinKey({ reserved_at: RESERVED_WEB, item_model_number: ITEM, qty: '3', order_id: 'ORD-1' }),
    'qty must stay load-bearing in the 1:1 key',
  );
  assert.notEqual(
    k,
    bfmrJoinKey({ reserved_at: RESERVED_WEB, item_model_number: ITEM, qty: '2', order_id: 'ORD-2' }),
    'order_id must stay load-bearing in the 1:1 key',
  );
});

test('REGRESSION: normalizeBfmrTimestamp still folds both surface spellings', () => {
  assert.equal(normalizeBfmrTimestamp(RESERVED_LOCAL), '2026-09-18T14:22:31');
  assert.equal(normalizeBfmrTimestamp(RESERVED_WEB), '2026-09-18T14:22:31');
  assert.equal(normalizeBfmrTimestamp(null), '');
});
