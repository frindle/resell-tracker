// Adversarial repo-style test for: rt-autobuy-decision (tsx --test, tsconfig @/ paths)
// evaluateAutoBuy enforces, server-side and all-at-once, the BFMR->Amazon auto-buy gate.
// PRIMARY GATE (checked FIRST): only an UNFILLED reservation may buy. remaining =
// requiredQty - orderedQty (sum of OrderBfmrLink.quantity). remaining<=0 => never buy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateAutoBuy } from '@/lib/autoBuyDecision';

// Fully-approvable baseline; each test perturbs ONE field.
const RES = { id: 1, requiredQty: 3, orderedQty: 0, maxPrice: 100 };
const GROUP = { cardId: 7, savedAddressId: 9, autoBuyEnabled: false };
const OFFER = { soldAndShippedByAmazon: true, price: 100 };
const CTX = { killSwitch: false, confirmationToken: 'human-ok' };

test('happy path with explicit confirmation token => approved, qty = remaining, card/address echoed', () => {
  const d = evaluateAutoBuy(RES, GROUP, OFFER, CTX);
  assert.equal(d.approved, true);
  assert.deepEqual(d.reasons, []);
  assert.equal(d.qty, 3);            // remaining = 3 - 0
  assert.equal(d.cardId, 7);
  assert.equal(d.savedAddressId, 9);
});

test('happy path via group auto-buy opt-in, no token => approved', () => {
  const d = evaluateAutoBuy(RES, { ...GROUP, autoBuyEnabled: true }, OFFER, { killSwitch: false, confirmationToken: null });
  assert.equal(d.approved, true);
});

test('PRIMARY GATE: already FILLED reservation (orderedQty >= requiredQty) => blocked, even with all else perfect', () => {
  const d = evaluateAutoBuy({ ...RES, requiredQty: 3, orderedQty: 3 }, GROUP, OFFER, CTX);
  assert.equal(d.approved, false);
  assert.ok(d.reasons.some(r => /fill|remain/i.test(r)), 'reason should mention filled/remaining');
});

test('PRIMARY GATE: partially filled caps qty at remaining-needed', () => {
  const d = evaluateAutoBuy({ ...RES, requiredQty: 5, orderedQty: 3 }, GROUP, OFFER, CTX);
  assert.equal(d.approved, true);
  assert.equal(d.qty, 2);            // 5 - 3
});

test('OVER-TRIGGER GUARD: NOT sold+shipped by Amazon => blocked despite everything else', () => {
  const d = evaluateAutoBuy(RES, GROUP, { soldAndShippedByAmazon: false, price: 100 }, CTX);
  assert.equal(d.approved, false);
  assert.ok(d.reasons.some(r => /amazon/i.test(r)));
});

test('price boundary: price EXACTLY equals ceiling => approved', () => {
  const d = evaluateAutoBuy(RES, GROUP, { soldAndShippedByAmazon: true, price: 100 }, CTX);
  assert.equal(d.approved, true);
});

test('price boundary: one cent OVER ceiling => blocked', () => {
  const d = evaluateAutoBuy(RES, GROUP, { soldAndShippedByAmazon: true, price: 100.01 }, CTX);
  assert.equal(d.approved, false);
  assert.ok(d.reasons.some(r => /price|ceiling|exceed/i.test(r)));
});

test('no price ceiling set (maxPrice null) => blocked (never buy without a ceiling)', () => {
  const d = evaluateAutoBuy({ ...RES, maxPrice: null }, GROUP, OFFER, CTX);
  assert.equal(d.approved, false);
});

test('offer price missing (null) => blocked', () => {
  const d = evaluateAutoBuy(RES, GROUP, { soldAndShippedByAmazon: true, price: null }, CTX);
  assert.equal(d.approved, false);
});

test('no designated card => blocked', () => {
  const d = evaluateAutoBuy(RES, { ...GROUP, cardId: null }, OFFER, CTX);
  assert.equal(d.approved, false);
});

test('no designated saved address => blocked', () => {
  const d = evaluateAutoBuy(RES, { ...GROUP, savedAddressId: null }, OFFER, CTX);
  assert.equal(d.approved, false);
});

test('OVER-TRIGGER GUARD: kill switch engaged => blocked even with token + all good', () => {
  const d = evaluateAutoBuy(RES, GROUP, OFFER, { killSwitch: true, confirmationToken: 'human-ok' });
  assert.equal(d.approved, false);
  assert.ok(d.reasons.some(r => /kill/i.test(r)));
});

test('AUTHORIZATION GATE: no token AND group opt-in off => blocked', () => {
  const d = evaluateAutoBuy(RES, GROUP, OFFER, { killSwitch: false, confirmationToken: null });
  assert.equal(d.approved, false);
  assert.ok(d.reasons.some(r => /confirm|opt|authori/i.test(r)));
});
