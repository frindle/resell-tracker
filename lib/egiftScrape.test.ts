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

test('parseEgiftImage accepts real image bytes only, with or without a data: prefix', async () => {
  const { parseEgiftImage } = await import('./egiftScrape.ts');
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]).toString('base64');
  assert.equal(parseEgiftImage({ image: png })?.mimeType, 'image/png');
  assert.equal(parseEgiftImage({ image: `data:image/png;base64,${png}` })?.ext, '.png');
  const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32)]).toString('base64');
  assert.equal(parseEgiftImage({ image: jpg })?.mimeType, 'image/jpeg');
  assert.equal(parseEgiftImage({ image: Buffer.from('<html>not an image at all</html>').toString('base64') }), null);
  assert.equal(parseEgiftImage({ image: 123 }), null);
  assert.equal(parseEgiftImage({}), null);
  assert.equal(parseEgiftImage(null), null);
});
