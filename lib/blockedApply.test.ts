import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planBlockedApply, type ApplyCandidate } from './blockedApply.ts';

const PICK = 'pickup';
const o = (id: number, shippingAddress: string | null, extra: Partial<ApplyCandidate> = {}): ApplyCandidate =>
  ({ id, platform: 'Amazon', shippingAddress, buyerId: null, ...extra });

test('an address match is recorded under its pattern', () => {
  const plan = planBlockedApply([o(1, 'Pat Doe - Springfield, IL'), o(2, '1 Main St, Springfield, IL 62701')], ['Springfield, IL'], [], PICK);
  assert.deepEqual([...plan], [['Springfield, IL', [1, 2]]]);
});

test('matching ignores case and uses the first pattern that fits', () => {
  const plan = planBlockedApply([o(1, '1 MAIN ST, SPRINGFIELD, IL')], ['1 main st', 'springfield, il'], [], PICK);
  assert.deepEqual([...plan], [['1 main st', [1]]]);
});

test('no match leaves the order alone', () => {
  assert.equal(planBlockedApply([o(1, '9 Elm St, Dayton, OH')], ['Springfield, IL'], [], PICK).size, 0);
});

test('a blank pattern matches nothing', () => {
  assert.equal(planBlockedApply([o(1, '9 Elm St, Dayton, OH')], ['  '], [], PICK).size, 0);
});

test('pickup rule needs no address, no buyer and an opted-in platform', () => {
  const plan = planBlockedApply(
    [o(1, null), o(2, null, { buyerId: 7 }), o(3, null, { platform: 'Target' }), o(4, '')],
    [], ['Amazon'], PICK);
  assert.deepEqual([...plan], [[PICK, [1, 4]]]);
});
