/**
 * Tests for the OCR verifier's verdict logic.
 *
 *   npm run test:giftcard-ocr
 *
 * No test framework is installed in this repo, so these run on Node's built-in
 * runner with type stripping. They cover the part that is genuinely easy to get
 * wrong and expensive to get wrong: the boundary between "flag this" and "say
 * nothing". A verifier that flags Costco receipts trains its user to ignore it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  checkCardAgainstOcr,
  editDistance,
  looksLikeReceipt,
  normalizeCode,
  verifyOrderCards,
} from './giftCardOcrVerify.ts';
import type { GiftCardOcrResult } from './giftCardOcr.ts';

function ocr(candidates: [string, number][], texts: string[] = []): GiftCardOcrResult {
  return {
    ok: true,
    model_set: 'medium',
    long_edge: 1024,
    elapsed_s: 1,
    variants: [
      { variant: 'redchan+stretch14', elapsed_s: 0.5, n_boxes: 10, texts, candidates: candidates.map(c => c[0]) },
      { variant: 'grayscale', elapsed_s: 0.5, n_boxes: 10, texts, candidates: candidates.filter(c => c[1] > 1).map(c => c[0]) },
    ],
    candidates: candidates.map(([pin, agreement]) => ({
      pin,
      agreement,
      variants: agreement > 1 ? ['redchan+stretch14', 'grayscale'] : ['redchan+stretch14'],
    })),
    texts,
    consensus: candidates.filter(c => c[1] > 1).map(c => c[0]),
  };
}

const CARD = { id: 1, cardNumber: 'NAAWGLYUYCN382DY', pin: null, label: 'DoorDash $100' };

test('normalizeCode strips formatting so stored and read codes compare equal', () => {
  assert.equal(normalizeCode(' 3124-1974 5681 4647 '), '3124197456814647');
  assert.equal(normalizeCode(null), '');
});

test('CONFIRMED when a candidate equals the entered code', () => {
  const r = checkCardAgainstOcr(CARD, ocr([['NAAWGLYUYCN382DY', 2]]));
  assert.equal(r.verdict, 'CONFIRMED');
  assert.equal(r.matched, 'NAAWGLYUYCN382DY');
  assert.equal(r.matchedAgreement, 2);
});

test('CONFIRMED on a single-variant read too — union recall is what avoids false flags', () => {
  assert.equal(checkCardAgainstOcr(CARD, ocr([['NAAWGLYUYCN382DY', 1]])).verdict, 'CONFIRMED');
});

test('CONFIRMED ignores formatting differences in the stored code', () => {
  const spaced = { ...CARD, cardNumber: 'NAAW GLYU YCN3 82DY' };
  assert.equal(checkCardAgainstOcr(spaced, ocr([['NAAWGLYUYCN382DY', 2]])).verdict, 'CONFIRMED');
});

test('MISMATCH when codes were read and none is this card', () => {
  const r = checkCardAgainstOcr(CARD, ocr([['NAAWGLYUYCN382DZ', 2]]));
  assert.equal(r.verdict, 'MISMATCH');
  // Diagnostic only — present for the human, never used to decide.
  assert.equal(r.nearest?.distance, 1);
});

test('a one-character difference is still a MISMATCH — no fuzzy pass', () => {
  assert.equal(checkCardAgainstOcr(CARD, ocr([['NAAWGLYUYCN382D0', 2]])).verdict, 'MISMATCH');
});

test('NO_READ when nothing code-shaped came back, and it is not a mismatch', () => {
  const r = checkCardAgainstOcr(CARD, ocr([], ['GIFT', 'CARD']));
  assert.equal(r.verdict, 'NO_READ');
});

test('NOT_APPLICABLE for a Costco receipt, even though it carries a 16-digit number', () => {
  // This is the case that decides whether the flag survives contact with
  // reality: receipt transaction barcodes are code-shaped, and calling them
  // mismatches would flag every receipt in the pile.
  const r = checkCardAgainstOcr(
    CARD,
    ocr([['1234567890123456', 2]], ['APPROVED PURCHASE', 'COSTCO WHOLESALE', 'SUBTOTAL']),
  );
  assert.equal(r.verdict, 'NOT_APPLICABLE');
  assert.ok(r.receiptMarkers.length >= 2);
});

test('a real match on a receipt-looking image still wins', () => {
  const r = checkCardAgainstOcr(
    CARD,
    ocr([['NAAWGLYUYCN382DY', 2]], ['APPROVED PURCHASE', 'COSTCO WHOLESALE']),
  );
  assert.equal(r.verdict, 'CONFIRMED');
});

test('one receipt marker alone is not enough to call it a receipt', () => {
  assert.equal(looksLikeReceipt(['MEMBER']), false);
  assert.equal(looksLikeReceipt(['MEMBER', 'SUBTOTAL']), true);
});

test('WRONG_CARD when the read belongs to a different record', () => {
  const known = new Map([['2052600326118197', 'order #883 (Southwest Airlines)']]);
  const r = checkCardAgainstOcr(CARD, ocr([['2052600326118197', 2]]), known);
  assert.equal(r.verdict, 'WRONG_CARD');
  assert.equal(r.foundElsewhere?.owner, 'order #883 (Southwest Airlines)');
});

test('a card with no code entered is never a mismatch', () => {
  const blank = { id: 2, cardNumber: '', pin: null };
  assert.equal(checkCardAgainstOcr(blank, ocr([['NAAWGLYUYCN382DY', 2]])).verdict, 'NO_READ');
});

test('editDistance is a plain Levenshtein', () => {
  assert.equal(editDistance('ABC', 'ABC'), 0);
  assert.equal(editDistance('ABC', 'ABD'), 1);
  assert.equal(editDistance('', 'ABC'), 3);
});

test('order roll-up pools candidates across photos before judging any card', () => {
  // Two cards, two photos, each photo showing only one of them. Judging per
  // photo would flag both; pooling confirms both.
  const cards = [
    { id: 1, cardNumber: 'AAAAAAAAAAAAAAA1', pin: null },
    { id: 2, cardNumber: 'BBBBBBBBBBBBBBB2', pin: null },
  ];
  const out = verifyOrderCards(cards, [
    { id: 10, name: 'a.heic', ocr: ocr([['AAAAAAAAAAAAAAA1', 2]]) },
    { id: 11, name: 'b.heic', ocr: ocr([['BBBBBBBBBBBBBBB2', 2]]) },
  ]);
  assert.equal(out.flagged, 0);
  assert.deepEqual(out.results.map(r => r.verdict), ['CONFIRMED', 'CONFIRMED']);
});

test('order roll-up counts only MISMATCH/WRONG_CARD as flagged', () => {
  const cards = [
    { id: 1, cardNumber: 'AAAAAAAAAAAAAAA1', pin: null },
    { id: 2, cardNumber: 'CCCCCCCCCCCCCCC3', pin: null },
  ];
  const out = verifyOrderCards(cards, [
    { id: 10, name: 'a.heic', ocr: ocr([['AAAAAAAAAAAAAAA1', 2]]) },
  ]);
  assert.equal(out.flagged, 1);
  assert.deepEqual(out.results.map(r => r.verdict), ['CONFIRMED', 'MISMATCH']);
});

test('the audit payload carries what each variant read', () => {
  const out = verifyOrderCards([CARD], [
    { id: 10, name: 'a.heic', ocr: ocr([['NAAWGLYUYCN382DZ', 1]]) },
  ]);
  const audit = out.results[0];
  assert.equal(audit.verdict, 'MISMATCH');
  assert.ok(audit.variants.length >= 2);
  assert.ok(audit.checkedAt);
  assert.equal(audit.modelSet, 'medium');
});
