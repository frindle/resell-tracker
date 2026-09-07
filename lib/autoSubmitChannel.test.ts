/**
 * Tests for the auto-submit channel decision.
 *
 *   npm run test:auto-submit-channel
 *
 * No test framework is installed in this repo, so these run on Node's built-in
 * runner with type stripping.
 *
 * The case that matters most: BFMR must map to `null`. Auto-submission has no
 * quantity awareness — the wrong-quantity bug — and BFMR tracking goes out ONLY
 * via the manual reservation-linker, which is quantity/split-aware through
 * lib/bfmrPushGate.ts. A rule that routes a BFMR buyer name into an auto-submit
 * channel reintroduces exactly that defect.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { autoSubmitChannel } from './autoSubmitChannel.ts';

test('BFMR never gets an auto-submit channel', () => {
  assert.equal(autoSubmitChannel('BFMR'), null);
  assert.equal(autoSubmitChannel('bfmr'), null, 'lowercase bfmr must not auto-submit');
  assert.equal(autoSubmitChannel('BFMR LLC'), null, 'a BFMR company name must not auto-submit');
});

test('BG buyer names map to BG', () => {
  assert.equal(autoSubmitChannel('BuyingGroup'), 'BG');
  assert.equal(autoSubmitChannel('Buying Group'), 'BG');
  assert.equal(autoSubmitChannel('buyinggroup'), 'BG');
  assert.equal(autoSubmitChannel('BUYING GROUP INC'), 'BG');
});

test('BigSky buyer names map to BigSky', () => {
  assert.equal(autoSubmitChannel('BigSky'), 'BigSky');
  assert.equal(autoSubmitChannel('Big Sky'), 'BigSky');
  assert.equal(autoSubmitChannel('bigsky'), 'BigSky');
  assert.equal(autoSubmitChannel('BIG SKY OUTFITTERS'), 'BigSky');
});

test('unrecognized buyers get no channel', () => {
  assert.equal(autoSubmitChannel('Amazon'), null);
  assert.equal(autoSubmitChannel('some random reseller'), null);
  assert.equal(autoSubmitChannel(''), null);
});

test('missing buyer names are safe', () => {
  assert.equal(autoSubmitChannel(null), null);
  assert.equal(autoSubmitChannel(undefined), null);
});
