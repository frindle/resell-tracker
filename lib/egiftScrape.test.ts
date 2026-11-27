import test from 'node:test';
import assert from 'node:assert/strict';
import { egiftScrapeCommand, egiftScrapeBlocker, egiftSecretConfigured, normalizeCardNumber, parseEgiftCard } from './egiftScrape.ts';
import { REVIEW_CODE_SOURCE, REVIEWED_CODE_SOURCE } from './giftCardReview.ts';

test('egiftScrapeCommand targets the extension and carries only the order id', () => {
  assert.deepEqual(egiftScrapeCommand(7), { type: 'SCRAPE_EGIFT', targetBrowser: 'chrome', payload: { orderId: 7 } });
});

test('egiftScrapeBlocker explains what is missing', () => {
  assert.match(egiftScrapeBlocker({ hasLink: false, hasEmail: true }) ?? '', /link/i);
  assert.match(egiftScrapeBlocker({ hasLink: true, hasEmail: false }) ?? '', /email/i);
  assert.equal(egiftScrapeBlocker({ hasLink: true, hasEmail: true }), null);
});

test('egiftSecretConfigured is false for unset or empty', () => {
  assert.equal(egiftSecretConfigured({}), false);
  assert.equal(egiftSecretConfigured({ EXTENSION_SHARED_SECRET: '' }), false);
  assert.equal(egiftSecretConfigured({ EXTENSION_SHARED_SECRET: 'x' }), true);
});

test('parseEgiftCard keeps a complete card and strips spaces from codes', () => {
  assert.deepEqual(
    parseEgiftCard({ cardNumber: '1111 2222 3333', pin: ' 99 88 ', merchant: 'Example Store', value: 50 }),
    { merchant: 'Example Store', value: 50, cardNumber: '111122223333', pin: '9988', codeSource: REVIEWED_CODE_SOURCE },
  );
});

test('parseEgiftCard flags a card with no readable merchant or value for review', () => {
  const noValue = parseEgiftCard({ cardNumber: '1234567890', merchant: 'Example Store' });
  assert.equal(noValue?.codeSource, REVIEW_CODE_SOURCE);
  assert.equal(noValue?.value, 0);
  assert.equal(noValue?.merchant, 'eGift');
  assert.equal(noValue?.pin, null);
  assert.equal(parseEgiftCard({ cardNumber: '1234567890', value: 25 })?.codeSource, REVIEW_CODE_SOURCE);
  assert.equal(parseEgiftCard({ cardNumber: '1234567890', merchant: 'X', value: -5 })?.codeSource, REVIEW_CODE_SOURCE);
});

test('normalizeCardNumber strips spaces and dashes', () => {
  assert.equal(normalizeCardNumber('1234 5678-9012'), '123456789012');
  assert.equal(normalizeCardNumber('1234567890'), '1234567890');
});

test('parseEgiftCard rejects input without a usable code', () => {
  for (const v of [null, 'x', {}, { cardNumber: 12345678 }, { cardNumber: ' 12 ' }]) {
    assert.equal(parseEgiftCard(v), null);
  }
});
