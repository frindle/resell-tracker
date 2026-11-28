import test from 'node:test';
import assert from 'node:assert/strict';

import { brandMentions, cardBrand } from './cardBrand.ts';

// Made-up codes; boxes are [x0, y0, x1, y1] as fractions of the photo.
const A = 'ABCD1234EFGH5678';
const B = 'WXYZ9876QRST4321';

test('one brand on the photo: the brand comes from the photo', () => {
  const lines = [{ text: 'DOORDASH' }, { text: 'GIFT CODE: ABCD 1234 EFGH 5678' }];
  assert.deepEqual(cardBrand(A, lines, []), { brand: 'DoorDash', from: 'photo', others: [] });
});

test('two packs side by side: each code gets the brand printed beside it', () => {
  const lines = [
    { text: 'DOORDASH', box: [0.1, 0.2, 0.3, 0.25] as [number, number, number, number] },
    { text: 'ABCD 1234 EFGH 5678', box: [0.1, 0.5, 0.3, 0.55] as [number, number, number, number] },
    { text: 'Uber Eats', box: [0.7, 0.2, 0.9, 0.25] as [number, number, number, number] },
    { text: 'WXYZ 9876 QRST 4321', box: [0.7, 0.5, 0.9, 0.55] as [number, number, number, number] },
  ];
  assert.deepEqual(cardBrand(A, lines, []), { brand: 'DoorDash', from: 'card', others: ['Uber Eats'] });
  assert.deepEqual(cardBrand(B, lines, []), { brand: 'Uber Eats', from: 'card', others: ['DoorDash'] });
});

test('a code halfway between two brands gets none, and the photo says it shows both', () => {
  const lines = [
    { text: 'DOORDASH', box: [0.0, 0.2, 0.2, 0.25] as [number, number, number, number] },
    { text: 'Uber Eats', box: [0.8, 0.2, 1.0, 0.25] as [number, number, number, number] },
    { text: 'ABCD 1234 EFGH 5678', box: [0.4, 0.5, 0.6, 0.55] as [number, number, number, number] },
  ];
  assert.deepEqual(cardBrand(A, lines, []), { brand: null, from: null, others: ['DoorDash', 'Uber Eats'] });
});

test('no brand on the photo: none', () => {
  assert.deepEqual(cardBrand(A, [{ text: 'ABCD 1234 EFGH 5678' }, { text: 'Thank you' }], []),
    { brand: null, from: null, others: [] });
});

test('a code line found by its first 8 characters when OCR garbled the rest', () => {
  const lines = [
    { text: 'DOORDASH', box: [0.1, 0.2, 0.3, 0.25] as [number, number, number, number] },
    { text: 'ABCD 1234 EFGH 56', box: [0.1, 0.5, 0.3, 0.55] as [number, number, number, number] },
    { text: 'Uber Eats', box: [0.7, 0.2, 0.9, 0.25] as [number, number, number, number] },
  ];
  assert.equal(cardBrand(A, lines, []).brand, 'DoorDash');
});

test('a brand from saved cards is found as a whole word, not inside another word', () => {
  assert.deepEqual(brandMentions([{ text: 'Best Buy gift card' }], ['Best Buy']), [{ brand: 'Best Buy', box: null }]);
  assert.deepEqual(brandMentions([{ text: 'best  buy' }], ['Best Buy']), [{ brand: 'Best Buy', box: null }]);
  assert.deepEqual(brandMentions([{ text: 'Best Buyer club' }], ['Best Buy']), []);
  assert.deepEqual(brandMentions([{ text: 'Applebee\'s' }], ['Apple']), []);
  // regex characters in a brand name are literal
  assert.deepEqual(brandMentions([{ text: 'Anything' }], ['A.y(']), []);
  assert.equal(cardBrand(A, [{ text: 'Best Buy' }, { text: 'ABCD 1234 EFGH 5678' }], ['Best Buy']).brand, 'Best Buy');
});

test('"UBER EATS" and "Uber" are one brand, Uber Eats, counted once', () => {
  assert.deepEqual(brandMentions([{ text: 'UBER EATS' }], ['Uber']), [{ brand: 'Uber Eats', box: null }]);
  assert.deepEqual(brandMentions([{ text: 'Uber' }], []), [{ brand: 'Uber Eats', box: null }]);
  assert.deepEqual(cardBrand(A, [{ text: 'UBER EATS' }, { text: 'Uber' }], []), { brand: 'Uber Eats', from: 'photo', others: [] });
});

type Bx = [number, number, number, number];

test('two packs side by side, codes known: each code still gets its own brand', () => {
  const lines = [
    { text: 'DOORDASH', box: [0.1, 0.2, 0.3, 0.25] as Bx },
    { text: 'ABCD 1234 EFGH 5678', box: [0.1, 0.5, 0.3, 0.55] as Bx },
    { text: 'Uber Eats', box: [0.7, 0.2, 0.9, 0.25] as Bx },
    { text: 'WXYZ 9876 QRST 4321', box: [0.7, 0.5, 0.9, 0.55] as Bx },
  ];
  assert.equal(cardBrand(A, lines, [], [A, B]).brand, 'DoorDash');
  assert.equal(cardBrand(B, lines, [], [A, B]).brand, 'Uber Eats');
});

test('one brand and two codes side by side: only the code next to the brand gets it', () => {
  const lines = [
    { text: 'DOORDASH', box: [0.1, 0.2, 0.3, 0.25] as Bx },
    { text: 'ABCD 1234 EFGH 5678', box: [0.1, 0.5, 0.3, 0.55] as Bx },
    { text: 'WXYZ 9876 QRST 4321', box: [0.7, 0.5, 0.9, 0.55] as Bx },
  ];
  assert.deepEqual(cardBrand(A, lines, [], [A, B]), { brand: 'DoorDash', from: 'card', others: [] });
  assert.deepEqual(cardBrand(B, lines, [], [A, B]), { brand: null, from: null, others: ['DoorDash'] });
});

test('stacked cards: a brand between two codes is the lower card\'s, never the upper one\'s', () => {
  const lines = [
    { text: 'DOORDASH', box: [0.2, 0.05, 0.8, 0.1] as Bx },
    { text: 'ABCD 1234 EFGH 5678', box: [0.2, 0.35, 0.8, 0.4] as Bx },
    { text: 'Uber Eats', box: [0.2, 0.45, 0.8, 0.5] as Bx },
    { text: 'WXYZ 9876 QRST 4321', box: [0.2, 0.75, 0.8, 0.8] as Bx },
  ];
  const a = cardBrand(A, lines, [], [A, B]);
  const b = cardBrand(B, lines, [], [A, B]);
  assert.notEqual(a.brand, 'Uber Eats');
  assert.ok(a.brand === null || a.brand === 'DoorDash');
  assert.deepEqual(b, { brand: 'Uber Eats', from: 'card', others: ['DoorDash'] });
});

test('a single code with one brand on the photo still gets it', () => {
  const lines = [
    { text: 'DOORDASH', box: [0.2, 0.05, 0.8, 0.1] as Bx },
    { text: 'ABCD 1234 EFGH 5678', box: [0.2, 0.35, 0.8, 0.4] as Bx },
  ];
  assert.equal(cardBrand(A, lines, [], [A]).brand, 'DoorDash');
  // two codes on one line (variant misreads) are still one line
  const twice = [...lines, { text: 'ABCD 1234 EFGH 5679', box: [0.2, 0.35, 0.8, 0.4] as Bx }];
  assert.equal(cardBrand(A, twice, [], [A, 'ABCD1234EFGH5679']).brand, 'DoorDash');
});

test('one brand, two code lines, no brand box: the photo\'s brand is not carried to either', () => {
  const lines = [
    { text: 'DOORDASH' },
    { text: 'ABCD 1234 EFGH 5678', box: [0.1, 0.5, 0.3, 0.55] as Bx },
    { text: 'WXYZ 9876 QRST 4321', box: [0.7, 0.5, 0.9, 0.55] as Bx },
  ];
  assert.equal(cardBrand(A, lines, [], [A, B]).brand, null);
  // no boxes at all and two distinct codes
  assert.equal(cardBrand(A, [{ text: 'DOORDASH' }, { text: A }, { text: B }], [], [A, B]).brand, null);
});

test('"Add to Apple Wallet" below the code does not beat the real logo', () => {
  const lines = [
    { text: 'DOORDASH', box: [0.2, 0.05, 0.8, 0.1] as Bx },
    { text: 'ABCD 1234 EFGH 5678', box: [0.2, 0.3, 0.8, 0.35] as Bx },
    { text: 'Add to Apple Wallet', box: [0.2, 0.4, 0.8, 0.45] as Bx },
  ];
  assert.equal(cardBrand(A, lines, [], [A]).brand, 'DoorDash');
  assert.deepEqual(brandMentions([{ text: 'Apple Pay' }], []), []);
  assert.deepEqual(brandMentions([{ text: 'Apple gift card' }], []), [{ brand: 'Apple', box: null }]);
});

test('a prefix match for a code\'s line is refused when it is ambiguous or another card\'s', () => {
  const dd = { text: 'DOORDASH', box: [0.1, 0.2, 0.3, 0.25] as Bx };
  const ue = { text: 'Uber Eats', box: [0.7, 0.2, 0.9, 0.25] as Bx };
  // two lines share the first 8 characters: neither is known to be this code's
  const two = [dd, { text: 'ABCD 1234 EFGH 56', box: [0.1, 0.5, 0.3, 0.55] as Bx }, ue, { text: 'ABCD 1234 XXXX 99', box: [0.7, 0.5, 0.9, 0.55] as Bx }];
  assert.equal(cardBrand(A, two, [], [A]).brand, null);
  // the one prefix line holds another read code
  const other = 'ABCD1234QRST4321';
  const one = [dd, { text: 'ABCD 1234 QRST 4321', box: [0.1, 0.5, 0.3, 0.55] as Bx }, ue];
  assert.equal(cardBrand(A, one, [], [A, other]).brand, null);
});

test('a brand is dropped only when its span lies inside a longer match', () => {
  assert.deepEqual(brandMentions([{ text: 'Apple and Applebee\'s' }], ['Applebee\'s']),
    [{ brand: 'Apple', box: null }, { brand: 'Applebee\'s', box: null }]);
  assert.deepEqual(brandMentions([{ text: 'Applebee\'s' }], ['Applebee\'s']), [{ brand: 'Applebee\'s', box: null }]);
});

test('no boxes at all: one brand is the photo\'s, two brands are none', () => {
  assert.equal(cardBrand(A, [{ text: 'Starbucks' }, { text: 'ABCD1234EFGH5678' }], []).from, 'photo');
  assert.deepEqual(cardBrand(A, [{ text: 'Starbucks' }, { text: 'Amazon' }, { text: 'ABCD1234EFGH5678' }], []),
    { brand: null, from: null, others: ['Amazon', 'Starbucks'] });
});
