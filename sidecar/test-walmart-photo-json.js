'use strict';
// Nov 2026: Walmart's delivered orders carry the proof-of-delivery photo in the
// page's order JSON as groups_*[].shipment.proofOfDelivery (and
// inHomeProofOfDelivery), as objects rather than bare URL strings. The detail
// scrape must find the URL inside those objects, fetch it as an image, and
// never use the driver's own photo. These tests run the real in-browser
// function against a stub page.
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
const { extractDetailInBrowser } = require('./src/walmart.js');

const PHOTO = 'https://photos.example.test/pod/abc123.jpg';
const DRIVER = 'https://photos.example.test/driver/face.jpg';

function orderWith(shipment, extra = {}) {
  return { props: { pageProps: { initialData: { data: { order: {
    groups_2101: [{ shipment, driver: { photoUrl: extra.driverPhoto ?? null } }],
  } } } } } };
}

// Stub page: an HTML string that says Delivered, the __NEXT_DATA__ script,
// no <img> or buttons, and a fetch that records what it was asked for.
function runOn(nextData, { contentType = 'image/jpeg', html = '<html><body>Delivered</body></html>' } = {}) {
  const fetched = [];
  global.document = {
    documentElement: { outerHTML: html },
    querySelector: sel => (sel === '#__NEXT_DATA__' && nextData ? { textContent: JSON.stringify(nextData) } : null),
    querySelectorAll: () => [],
  };
  global.location = { href: 'https://www.walmart.com/orders/1' };
  global.fetch = async (url) => {
    fetched.push(url);
    return {
      ok: true,
      headers: { get: h => (h.toLowerCase() === 'content-type' ? contentType : null) },
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    };
  };
  return extractDetailInBrowser().then(r => ({ r, fetched }));
}

test('photo URL nested in a proofOfDelivery object is found and fetched', async () => {
  const { r, fetched } = await runOn(orderWith({ proofOfDelivery: { imageUrl: PHOTO, timestamp: 'x' }, inHomeProofOfDelivery: null }));
  assert.equal(r.deliveryPhotoUrl, PHOTO);
  assert.deepEqual(fetched, [PHOTO]);
  assert.equal(r.deliveryPhotoMime, 'image/jpeg');
  assert.equal(r.deliveryPhotoBase64, Buffer.from([1, 2, 3]).toString('base64'));
  assert.equal(r.photoHints, undefined);
});

test('photo URL in an array under proofOfDelivery is found', async () => {
  const { r } = await runOn(orderWith({ proofOfDelivery: { photos: [{ url: PHOTO }] } }));
  assert.equal(r.deliveryPhotoUrl, PHOTO);
});

test('the driver photo is never used as the delivery photo', async () => {
  const { r, fetched } = await runOn(orderWith({ proofOfDelivery: null }, { driverPhoto: DRIVER }));
  assert.equal(r.deliveryPhotoUrl, undefined);
  assert.deepEqual(fetched, []);
});

test('a non-image URL from the JSON is dropped', async () => {
  const { r } = await runOn(orderWith({ proofOfDelivery: { url: 'https://www.walmart.com/help/pod' } }), { contentType: 'text/html' });
  assert.equal(r.deliveryPhotoUrl, undefined);
  assert.equal(r.deliveryPhotoBase64, undefined);
  assert.ok(r.photoHints.some(h => h.startsWith('json groups_2101[].shipment.proofOfDelivery:object{url}')), JSON.stringify(r.photoHints));
});

test('hints tell null apart from an object and list key names', async () => {
  const { r } = await runOn(orderWith({ proofOfDelivery: null, inHomeProofOfDelivery: { status: 'NONE', reason: 'x' } }));
  assert.equal(r.deliveryPhotoUrl, undefined);
  assert.ok(r.photoHints.includes('json groups_2101[].shipment.proofOfDelivery:null'), JSON.stringify(r.photoHints));
  assert.ok(r.photoHints.includes('json groups_2101[].shipment.inHomeProofOfDelivery:object{status,reason}'), JSON.stringify(r.photoHints));
  assert.ok(r.photoHints.includes('json groups_2101[].driver.photoUrl:null'), JSON.stringify(r.photoHints));
});

test('a delivered page with no order data says so', async () => {
  const { r } = await runOn(null);
  assert.deepEqual(r.photoHints, ['json none (no order data)']);
});

test('nothing is searched or hinted for an order not yet delivered', async () => {
  const { r, fetched } = await runOn(orderWith({ proofOfDelivery: { imageUrl: PHOTO } }), { html: '<html><body>Arriving Tuesday</body></html>' });
  assert.equal(r.deliveryPhotoUrl, undefined);
  assert.equal(r.photoHints, undefined);
  assert.deepEqual(fetched, []);
});
