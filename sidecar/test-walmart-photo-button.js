'use strict';
// Nov 2026: no Walmart delivery photo had ever been saved. For a delivered
// order with no photo on the first read, the sync waits, then clicks a button
// that opens the photo. That click must hit only photo-viewing buttons, never
// "Add photo" (reviews) or similar.
process.env.TRACKER_URL = process.env.TRACKER_URL || 'http://localhost:9';
process.env.TRACKER_USER_ID = process.env.TRACKER_USER_ID || '1';
const test = require('node:test');
const assert = require('node:assert/strict');

const libPath = require.resolve('./src/lib.js', { paths: [__dirname] });
class SessionExpiredError extends Error {}
require.cache[libPath] = {
  id: libPath, filename: libPath, loaded: true,
  exports: { SessionExpiredError, fetchLockedOrderNumbers: async () => new Set(), captureFailure: async () => ({}) },
};
const { PHOTO_BUTTON_RE } = require('./src/walmart.js');

test('photo-viewing buttons match', () => {
  for (const t of ['View photo', 'See delivery photo', 'View the delivery photo', 'Show photos', 'Proof of delivery', 'View proof of delivery']) {
    assert.ok(PHOTO_BUTTON_RE.test(t), t);
  }
});

test('other photo buttons do not', () => {
  for (const t of ['Add photo', 'Upload a photo', 'Write a review', 'Photo', 'Track package', 'Viewphoto']) {
    assert.ok(!PHOTO_BUTTON_RE.test(t), t);
  }
});
