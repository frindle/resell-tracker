// Adversarial pin for the PATCH /api/orders/:id route DECISION, now a pure
// function (resolveOrderPatchDecision) so it is testable without a route
// harness — the route is a thin caller of it.
//
// Two behaviours the gate flagged as unexercised at the route site
// (app/api/orders/[id]/route.ts) are pinned here:
//   1. an empty / no-patchable-fields PATCH must REJECT (route -> 400),
//   2. a valid PATCH records ONLY the field(s) actually patched — editing
//      cardId must never implicitly protect shippingAddress (order 919).
//
//   node --experimental-strip-types --test lib/orderPatchDecision.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveOrderPatchDecision,
  mergeUserEditedFields,
  parseUserEditedFields,
  ORDER_PATCHABLE_FIELDS,
} from './orderFieldSync.ts';

// --- 1. the 400-rejection decision -----------------------------------------

test('an empty body rejects (route returns 400) and records nothing', () => {
  const d = resolveOrderPatchDecision({});
  assert.equal(d.reject, true);
  assert.deepEqual(d.patchKeys, []);
  assert.equal(d.isCashbackOnlyCorrection, false);
});

test('a body with ONLY non-patchable keys still rejects — not just a literally empty object', () => {
  // adversarial: catches a mutant that checks Object.keys(body).length instead
  // of the count of PATCHABLE keys.
  const d = resolveOrderPatchDecision({ id: 5, someJunk: 'x', userEditedFields: '["hack"]' });
  assert.equal(d.reject, true);
  assert.deepEqual(d.patchKeys, []);
});

test('a body with at least one patchable field does NOT reject', () => {
  const d = resolveOrderPatchDecision({ cardId: 7, junk: 1 });
  assert.equal(d.reject, false);
  assert.deepEqual(d.patchKeys, ['cardId']);
});

// --- 2. records ONLY the patched field(s) ----------------------------------

test('editing cardId records ONLY cardId — never shippingAddress (order 919 conflation bug)', () => {
  const d = resolveOrderPatchDecision({ cardId: 7 });
  // compose exactly as the route does: merge the decision's patchKeys into
  // whatever was previously stored.
  const merged = mergeUserEditedFields(null, d.patchKeys);
  const fields = parseUserEditedFields(merged);
  assert.deepEqual(fields.sort(), ['cardId']);
  assert.ok(!fields.includes('shippingAddress'));
});

test('non-patchable keys in the body are never recorded as user-edited', () => {
  const d = resolveOrderPatchDecision({ shippingAddress: '146 R1ver Rhode', evil: 1, userEditedFields: '["x"]' });
  const merged = mergeUserEditedFields(null, d.patchKeys);
  assert.deepEqual(parseUserEditedFields(merged).sort(), ['shippingAddress']);
});

test('a real address edit ADDS to a prior cardId edit rather than replacing it', () => {
  const afterCard = mergeUserEditedFields(null, resolveOrderPatchDecision({ cardId: 7 }).patchKeys);
  const afterAddr = mergeUserEditedFields(afterCard, resolveOrderPatchDecision({ shippingAddress: 'x' }).patchKeys);
  assert.deepEqual(parseUserEditedFields(afterAddr).sort(), ['cardId', 'shippingAddress']);
});

// --- 3. the cashback-only lock-bypass (order 832) --------------------------

test('cashbackAmount alone is the lock-bypass; alongside anything else it is NOT', () => {
  assert.equal(resolveOrderPatchDecision({ cashbackAmount: 36 }).isCashbackOnlyCorrection, true);
  assert.equal(resolveOrderPatchDecision({ cashbackAmount: 36, cost: 10 }).isCashbackOnlyCorrection, false);
  // a single NON-cashback field is not a bypass either
  assert.equal(resolveOrderPatchDecision({ cost: 10 }).isCashbackOnlyCorrection, false);
  // cashbackAmount + a non-patchable key: patchKeys is still just cashbackAmount, so it IS a bypass
  assert.equal(resolveOrderPatchDecision({ cashbackAmount: 36, junk: 1 }).isCashbackOnlyCorrection, true);
});

test('the patchable-field set is the single source shared with the route', () => {
  // guards against the route drifting from a divergent inline list.
  assert.ok(ORDER_PATCHABLE_FIELDS.has('shippingAddress'));
  assert.ok(ORDER_PATCHABLE_FIELDS.has('cardId'));
  assert.ok(ORDER_PATCHABLE_FIELDS.has('cashbackAmount'));
  assert.ok(!ORDER_PATCHABLE_FIELDS.has('userEditedFields'));
});
