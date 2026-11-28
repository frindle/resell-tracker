import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readGiftCodes, plausibleCode, photoMerchant, formatGiftCode } from './giftCodeParse.ts';
import { canonicalGiftBrand } from './giftBrand.ts';

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
  // two codes and no boxes: the one brand is not carried to either
  assert.equal(r[0].merchant, null);
  assert.deepEqual(r[0].otherBrands, ['DoorDash']);
});

test('a result carries the brand, where it was read and the other brands', () => {
  assert.deepEqual(readGiftCodes(['UBER EATS', 'GIFT CODE: QWRT 7K2M PLXV 9NBH']), [
    { code: 'QWRT7K2MPLXV9NBH', merchant: 'Uber Eats', merchantFrom: 'photo', otherBrands: [], label: 'code' },
  ]);
  assert.deepEqual(readGiftCodes(['QWRT 7K2M PLXV 9NBH']), [
    { code: 'QWRT7K2MPLXV9NBH', merchant: null, merchantFrom: null, otherBrands: [], label: 'code' },
  ]);
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
  // A barcode number with one misread digit is not a code.
  assert.equal(plausibleCode('312420588A826047'), false);
  assert.equal(plausibleCode('31242058AB826C47'), false);
  assert.equal(plausibleCode('Q7RT9K2M4L8V3N6H'), true);
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

test('a photo naming two brands gives no brand (it used to be the one named most)', () => {
  const lines = ['UBER EATS', 'DOORDASH', 'DOORDASH GC', 'GIFT CODE: QWRT 7K2M PLXV 9NBH'];
  const r = readGiftCodes(lines);
  assert.equal(r[0].merchant, null);
  assert.equal(r[0].merchantFrom, null);
  assert.deepEqual(r[0].otherBrands, ['DoorDash', 'Uber Eats']);
  // the majority helper itself is unchanged
  assert.equal(photoMerchant(lines), 'DoorDash');
});

test('boxes tie each code to the brand printed beside it; known brands are read too', () => {
  const boxes: { t: string; b: [number, number, number, number] }[] = [
    { t: 'DOORDASH', b: [0.1, 0.2, 0.3, 0.25] },
    { t: 'QWRT 7K2M PLXV 9NBH', b: [0.1, 0.5, 0.3, 0.55] },
    { t: 'Best Buy', b: [0.7, 0.2, 0.9, 0.25] },
    { t: 'ZXCV B4N7 MLKJ H8GF', b: [0.7, 0.5, 0.9, 0.55] },
  ];
  const r = readGiftCodes(boxes.map(x => x.t), { boxes, known: ['Best Buy'] });
  assert.deepEqual(r.map(c => [c.code, c.merchant, c.merchantFrom]), [
    ['QWRT7K2MPLXV9NBH', 'DoorDash', 'card'], ['ZXCVB4N7MLKJH8GF', 'Best Buy', 'card'],
  ]);
});

test('OCR brand goes through the shared canonical name (Uber Eats / UBER EATS / Uber)', () => {
  for (const line of ['Uber Eats', 'UBER EATS', 'Uber', 'UBER GIFT CARD']) {
    const r = readGiftCodes([line, 'GIFT CODE: QWRT 7K2M PLXV 9NBH']);
    assert.equal(r[0].merchant, canonicalGiftBrand(line), line);
    assert.equal(photoMerchant([line]), canonicalGiftBrand('uber'), line);
  }
});
