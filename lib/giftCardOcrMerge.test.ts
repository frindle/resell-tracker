import test from 'node:test';
import assert from 'node:assert/strict';

import { mergeRereadImage } from './giftCardOcrMerge.ts';

type Img = { attachmentId: number; name: string };
type Sug = { attachmentId: number; pin: string };
type An = { images: Img[]; suggestions: Sug[]; verification: string; truncated: null };

const prev: An = {
  images: [{ attachmentId: 1, name: 'a-old' }, { attachmentId: 2, name: 'b' }],
  suggestions: [
    { attachmentId: 1, pin: 'AAA' },
    { attachmentId: 2, pin: 'BBB' },
    { attachmentId: 1, pin: 'CCC' },
  ],
  verification: 'full',
  truncated: null,
};

test("the re-read photo's image is replaced and the others are untouched", () => {
  const out = mergeRereadImage(prev, { images: [{ attachmentId: 1, name: 'a-new' }], suggestions: [] });
  assert.deepEqual(out.images, [{ attachmentId: 1, name: 'a-new' }, { attachmentId: 2, name: 'b' }]);
  assert.equal(out.images[1], prev.images[1]);
  assert.equal(out.verification, 'full');
});

test("that photo's old suggestions are dropped and the new ones added", () => {
  const out = mergeRereadImage(prev, {
    images: [{ attachmentId: 1, name: 'a-new' }],
    suggestions: [{ attachmentId: 1, pin: 'DDD' }],
  });
  assert.deepEqual(out.suggestions, [{ attachmentId: 2, pin: 'BBB' }, { attachmentId: 1, pin: 'DDD' }]);
});

test('a new suggestion whose pin another photo already has is skipped', () => {
  const out = mergeRereadImage(prev, {
    images: [{ attachmentId: 1, name: 'a-new' }],
    suggestions: [{ attachmentId: 1, pin: 'BBB' }, { attachmentId: 1, pin: 'EEE' }, { attachmentId: 1, pin: 'EEE' }],
  });
  assert.deepEqual(out.suggestions, [{ attachmentId: 2, pin: 'BBB' }, { attachmentId: 1, pin: 'EEE' }]);
});

test('an unknown attachment id appends the image', () => {
  const out = mergeRereadImage(prev, {
    images: [{ attachmentId: 9, name: 'new' }],
    suggestions: [{ attachmentId: 9, pin: 'ZZZ' }],
  });
  assert.deepEqual(out.images.map(i => i.attachmentId), [1, 2, 9]);
  assert.equal(out.suggestions.length, 4);
  assert.equal(out.suggestions[3].pin, 'ZZZ');
});

test('the input is not changed, and an answer with no image changes nothing', () => {
  const copy = structuredClone(prev);
  mergeRereadImage(prev, { images: [{ attachmentId: 1, name: 'x' }], suggestions: [] });
  assert.deepEqual(prev, copy);
  assert.equal(mergeRereadImage(prev, { images: [], suggestions: [] }), prev);
});
