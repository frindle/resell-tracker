import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readGiftCodes, plausibleCode, photoMerchant, formatGiftCode } from './giftCodeParse.ts';

// Made-up codes in the printed shapes; never real ones.
test('reads a labelled code and strips the label', () => {
  const r = readGiftCodes(['UBER EATS', 'GIFT CODE: QWRT 7K2M PLXV 9NBH']);
  assert.deepEqual(r.map(c => c.code), ['QWRT7K2MPLXV9NBH']);
  assert.equal(r[0].merchant, 'Uber Eats');
});

test('tolerates joined groups, commas and the PIN label bleeding into the tail', () => {
  const r = readGiftCodes(['DOORDASH GC', 'PIN: ZXCV,B4N7MLKJ H8GFIN', 'ASDF Q1W2 ERTY UIO3:N']);
  assert.deepEqual(r.map(c => c.code), ['ZXCVB4N7MLKJH8GF', 'ASDFQ1W2ERTYUIO3']);
  assert.equal(r[0].label, 'pin');
  assert.equal(r[0].merchant, 'DoorDash');
});

test('ignores barcodes, prose and a word beside a number', () => {
  const r = readGiftCodes([
    '3282206480105416', 'the QR code or visit ubereats.com/redeem', 'UBER EATS 7999', '10/28/2026 11:53 1320 9 75 13',
  ]);
  assert.deepEqual(r, []);
});

test('does not join two lines into a code', () => {
  assert.deepEqual(readGiftCodes(['UBER EATS', '123456789012345']), []);
});

test('dedupes the same code read by two variants', () => {
  assert.equal(readGiftCodes(['QWRT 7K2M PLXV 9NBH', 'QWRT 7K2M PLXV 9NBH']).length, 1);
});

test('plausibleCode', () => {
  assert.equal(plausibleCode('QWRT7K2MPLXV9NBH'), true);
  assert.equal(plausibleCode('1234567890123456'), false);
  assert.equal(plausibleCode('UBEREATSGC799999'), false);
  assert.equal(plausibleCode('ABCDEFGHIJKLMNOP'), false);
});

test('photoMerchant and formatGiftCode', () => {
  assert.equal(photoMerchant(['nothing here']), null);
  assert.equal(formatGiftCode('QWRT7K2MPLXV9NBH'), 'QWRT 7K2M PLXV 9NBH');
});

test('masked card numbers are not gift codes', () => {
  assert.equal(plausibleCode('00000000000X3069'), false);
  assert.equal(plausibleCode('XXXXXXXXXXXX3069'), false);
  assert.equal(plausibleCode('OOOOOOOOOOOO3069'), false);
  assert.equal(plausibleCode('XXXX5XXXXXXX3069'), false);
  assert.equal(plausibleCode('0000000000A03069'), false);
  assert.equal(plausibleCode('QQQQQQQQ7K2MPLX9'), false);
  assert.deepEqual(readGiftCodes(['AID: A0000000980840', 'XXXXXXXXXXXX3069', 'Seq# 4280']), []);
  assert.deepEqual(readGiftCodes(['00000000 000X 3069 **** TOTAL']), []);
  for (const ok of ['QWRT7K2MPLXV9NBH', 'ZXCVB4N7MLKJH8GF', 'A0B0C0D0E0F0G0H1', 'X7KQ2M0OPL9XNB4W']) assert.equal(plausibleCode(ok), true, ok);
});
