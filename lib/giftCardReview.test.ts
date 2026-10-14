import test from 'node:test';
import assert from 'node:assert/strict';
import { isReviewCard, splitReview, codeSourceAfterEdit, REVIEW_CODE_SOURCE } from './giftCardReview.ts';

test('only the exact review codeSource is held; manual, OCR, NULL and a normal scrape pass', () => {
  assert.equal(isReviewCard({ codeSource: REVIEW_CODE_SOURCE }), true);
  for (const s of [null, undefined, 'manual', 'ocr_confirmed', 'egift_scrape', 'egift_scrape_review2']) {
    assert.equal(isReviewCard({ codeSource: s }), false, String(s));
  }
});

test('splitReview partitions without losing or reordering cards, and handles empty', () => {
  const cards = [{ id: 1, codeSource: null }, { id: 2, codeSource: REVIEW_CODE_SOURCE }, { id: 3, codeSource: 'egift_scrape' }, { id: 4, codeSource: REVIEW_CODE_SOURCE }];
  const r = splitReview(cards);
  assert.deepEqual(r.ok.map(c => c.id), [1, 3]);
  assert.deepEqual(r.held.map(c => c.id), [2, 4]);
  assert.deepEqual(splitReview([]), { ok: [], held: [] });
});

test('a review card is released only when one edit supplies BOTH merchant and a positive value', () => {
  const R = REVIEW_CODE_SOURCE;
  assert.equal(codeSourceAfterEdit(R, { merchant: 'Uber', value: 50 }), 'egift_scrape');
  assert.equal(codeSourceAfterEdit(R, { merchant: 'Uber' }), undefined);
  assert.equal(codeSourceAfterEdit(R, { value: 50 }), undefined);
  assert.equal(codeSourceAfterEdit(R, { merchant: '  ', value: 50 }), undefined);
  assert.equal(codeSourceAfterEdit(R, { merchant: 'Uber', value: 0 }), undefined);
  assert.equal(codeSourceAfterEdit(R, { merchant: 'Uber', value: '50' }), undefined);
  assert.equal(codeSourceAfterEdit(R, {}), undefined);
});

test('editing a non-review card never rewrites its codeSource', () => {
  for (const s of [null, undefined, 'manual', 'ocr_corrected', 'egift_scrape']) {
    assert.equal(codeSourceAfterEdit(s, { merchant: 'Uber', value: 50 }), undefined, String(s));
  }
});
