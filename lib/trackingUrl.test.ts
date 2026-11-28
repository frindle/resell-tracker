import test from 'node:test';
import assert from 'node:assert/strict';
import { trackingUrl, normalizeTrackingForSubmit, isAmazonTba } from './trackingUrl.ts';

test('a TBA number links to Amazon whatever its case or spacing', () => {
  const want = 'https://track.amazon.com/tracking/TBA123456789012';
  assert.equal(trackingUrl('TBA123456789012'), want);
  assert.equal(trackingUrl('tba123456789012'), want);
  assert.equal(trackingUrl(' TBA 1234 56789012 '), want);
});

test('other carriers keep their links', () => {
  assert.match(trackingUrl('1Z999AA10123456784'), /^https:\/\/www\.ups\.com\/track\?tracknum=/);
  assert.match(trackingUrl('96' + '1'.repeat(20)), /fedex\.com/);
  assert.match(trackingUrl('not a number'), /google\.com\/search/);
});

test('TBA numbers are normalised for submission, others untouched', () => {
  assert.equal(normalizeTrackingForSubmit(' tba 123456789012 '), 'TBA123456789012');
  assert.equal(normalizeTrackingForSubmit(' 1z999aa10123456784 '), '1z999aa10123456784');
  assert.equal(isAmazonTba('tba123456789012'), true);
  assert.equal(isAmazonTba('1Z999AA10123456784'), false);
});
