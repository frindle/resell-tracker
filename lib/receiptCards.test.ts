import test from 'node:test';
import assert from 'node:assert/strict';
import { merchantOnReceipt, planReceiptLinks, type ReceiptCard, type ReceiptPhoto } from './receiptCards.ts';

// Order 1039's shape: two Uber Eats packs and two DoorDash packs (two cards
// each) on one Costco trip. Codes are made up.
const cards: ReceiptCard[] = [
  { id: 1, merchant: 'DoorDash', cardNumber: 'NAAW GDRS C66K AAAA' },
  { id: 2, merchant: 'DoorDash', cardNumber: 'NAAW GFNW DPB3 BBBB' },
  { id: 3, merchant: 'Uber Eats', cardNumber: 'UE11 2233 4455 CCCC' },
  { id: 4, merchant: 'Uber Eats', cardNumber: 'UE11 2233 4455 DDDD' },
];

// The gift card summary slip, as OCR reads it.
const slip = [
  '======= Costco Summary Receipt =======', 'Purchased from Whse 1320',
  'UBER EATS', 'ACTIVATED', 'Successful', '0000000020648010871',
  'DOORDASH GC', 'ACTIVATED', 'Successful', '0000000019745681546',
  '11/11/2026 13:23 1320 8 231 8',
];

const photo = (attachmentId: number, o: Partial<ReceiptPhoto> = {}): ReceiptPhoto =>
  ({ attachmentId, receipt: null, kind: 'receipt', texts: slip, candidates: [], linkedCardIds: [], ...o });

test('merchantOnReceipt: full name across spacing, or a 4+ letter first word', () => {
  assert.equal(merchantOnReceipt('Uber Eats', ['282 UBEREATS']), true);
  assert.equal(merchantOnReceipt('DoorDash', ['124 DOORDASH GC']), true);
  assert.equal(merchantOnReceipt('Uber', ['282 UBER EATS']), true);
  assert.equal(merchantOnReceipt('Uber Eats', ['UBER GIFT CARD']), true);
  assert.equal(merchantOnReceipt('Amazon', ['124 DOORDASH GC']), false);
  // A short first word alone never counts.
  assert.equal(merchantOnReceipt('GAP Options', ['GAP 49.99']), false);
  assert.equal(merchantOnReceipt('GAP Options', ['GAP OPTIONS 49.99']), true);
});

test('a slip read as a receipt covers every card it names and is marked a receipt', () => {
  const plan = planReceiptLinks([photo(10)], cards);
  assert.deepEqual(plan.markReceipt, [10]);
  assert.deepEqual(plan.links.map(l => l.cardId), [1, 2, 3, 4]);
});

test('only cards whose merchant is on the receipt; existing links are not added twice', () => {
  const ddOnly = ['COSTCO WHOLESALE', '124 DOORDASH GC', 'PC 0000000019745681546 ACTIVATED', 'SUBTOTAL 79.99'];
  const plan = planReceiptLinks([photo(11, { texts: ddOnly, linkedCardIds: [1] })], cards);
  assert.deepEqual(plan.links, [{ attachmentId: 11, cardId: 2 }]);
});

test('a photo of the cards with the slip in the frame stays a card photo', () => {
  const plan = planReceiptLinks([photo(12, { texts: [...slip, 'PIN: NAAW GDRS C66K AAAA'] })], cards);
  assert.deepEqual(plan, { links: [], markReceipt: [] });
});

test('marked by hand: a receipt is matched whatever it was read as; a card photo never', () => {
  const plan = planReceiptLinks([
    photo(13, { receipt: true, kind: 'gift_card' }),
    photo(14, { receipt: false }),
  ], cards);
  assert.deepEqual(plan.markReceipt, []);
  assert.deepEqual(plan.links.map(l => [l.attachmentId, l.cardId]), [[13, 1], [13, 2], [13, 3], [13, 4]]);
});

test('not decided: card photos, unknown photos and receipts naming no card are left alone', () => {
  const plan = planReceiptLinks([
    photo(15, { kind: 'gift_card' }),
    photo(16, { kind: 'unknown' }),
    photo(17, { texts: ['COSTCO WHOLESALE', 'KS TRAIL MIX 17.59', 'SUBTOTAL 17.59'] }),
  ], cards);
  assert.deepEqual(plan, { links: [], markReceipt: [] });
});
