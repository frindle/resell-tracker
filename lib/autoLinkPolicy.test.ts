import test from 'node:test';
import assert from 'node:assert/strict';
import { dismissOnUnlink, lockBlocksRecalc } from './autoLinkPolicy.ts';

test('order 634: deleting the duplicate reservation\'s only link dismisses it', () => {
  assert.equal(dismissOnUnlink(0), true);
  // still linked to another order/shipment: leave it eligible
  assert.equal(dismissOnUnlink(1), false);
});

test('sync auto-link must not reprice a locked order; user actions still do', () => {
  assert.equal(lockBlocksRecalc(true, true), true);
  assert.equal(lockBlocksRecalc(true, undefined), false);
  assert.equal(lockBlocksRecalc(false, true), false);
  assert.equal(lockBlocksRecalc(null, true), false);
});
