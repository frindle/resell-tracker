// Package extraction from Amazon pages. Synthetic markup only, and it is a GUESS
// at Amazon's structure: no real saved page exists in this repo. These tests
// prove the extractor's logic, not that the selectors match live Amazon.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { parseAmazonPage } from './amazonPageParse.ts';

const doc = (html: string) => parseHTML(`<!doctype html><html><body>${html}</body></html>`).document as unknown as Document;
const DETAIL_URL = 'https://www.amazon.com/gp/your-account/order-details?orderID=111-0000000-0000001';
const TRACK_URL = 'https://www.amazon.com/gp/your-account/ship-track?orderId=111-0000000-0000001&shipmentId=XYZ';

const item = (title: string, qty?: number, asin = 'B000000001') =>
  `<div class="item-row"><div data-component="itemTitle"><a href="/dp/${asin}">${title}</a></div>${qty ? `<span class="od-item-view-qty">${qty}</span>` : ''}</div>`;
const shipment = (tracking: string | null, items: string) =>
  `<div data-component="shipment"><div>${tracking ? `Tracking ID: ${tracking}` : 'Not yet shipped'}</div><div data-component="purchasedItems">${items}</div></div>`;
const detail = (inner: string) => doc(`<div id="orderDetails" class="order-details"><div data-component="shipments">${inner}</div></div>`);

const pk = (d: Document, kind: 'detail' | 'tracking' = 'detail') => parseAmazonPage(d, kind, kind === 'detail' ? DETAIL_URL : TRACK_URL).orders[0]?.packages;

test('detail: two shipments of one order become two packages with their own items', () => {
  const p = pk(detail(
    shipment('TBA000000000001', item('Widget Alpha Long Name', 2)) +
    shipment('TBA000000000002', item('Gadget Beta Long Name', undefined, 'B000000002') + item('Widget Alpha Long Name', 1)),
  ))!;
  assert.equal(p.length, 2);
  assert.equal(p[0].trackingNumber, 'TBA000000000001');
  assert.equal(p[0].carrier, 'Amazon Logistics');
  assert.deepEqual(p[0].items, [{ title: 'Widget Alpha Long Name', asin: 'B000000001', quantity: 2 }]);
  assert.equal(p[1].items?.length, 2);
  assert.equal(p[1].items?.[0].quantity, 1);
  assert.equal(p[1].items?.[0].qtyAssumed, true); // no badge shown -> assumed, and flagged
});

test('detail: a shipment that has not shipped yet (no tracking) is not a package', () => {
  const p = pk(detail(shipment(null, item('Widget Alpha Long Name')) + shipment('TBA000000000002', item('Gadget Beta Long Name', 3, 'B000000002'))))!;
  assert.equal(p.length, 1);
  assert.equal(p[0].trackingNumber, 'TBA000000000002');
});

test('detail: shipment block whose items cannot be read is stored with items null, not guessed', () => {
  const p = pk(detail(`<div data-component="shipment"><div>Tracking ID: TBA000000000001</div><div>no recognisable item markup</div></div>`))!;
  assert.equal(p.length, 1);
  assert.equal(p[0].items, null);
});

test('detail: no shipment blocks at all -> packages from the tracking numbers with items null', () => {
  const p = pk(doc(`<div id="orderDetails"><div class="item-row"><div data-component="itemTitle"><a href="/dp/B000000001">Widget Alpha Long Name</a></div></div><div>Tracking ID: TBA000000000001</div></div>`))!;
  assert.equal(p.length, 1);
  assert.equal(p[0].items, null);
});

test('detail: a shipment block with two tracking numbers is ambiguous -> both packages unknown', () => {
  const p = pk(detail(`<div data-component="shipment"><div>Tracking ID: TBA000000000001</div><div>Tracking ID: TBA000000000002</div>${item('Widget Alpha Long Name')}</div>`))!;
  assert.equal(p.length, 2);
  assert.ok(p.every(x => x.items === null));
});

test('detail: same tracking in two blocks with different items -> kept once, items unknown', () => {
  const p = pk(detail(shipment('TBA000000000001', item('Widget Alpha Long Name', 1)) + shipment('TBA000000000001', item('Gadget Beta Long Name', 1, 'B000000002'))))!;
  assert.equal(p.length, 1);
  assert.equal(p[0].items, null);
});

test('detail: UPS tracking gets a carrier, qty read from "Qty:" text', () => {
  const p = pk(detail(`<div data-component="shipment"><div>Carrier: UPS</div>\n<div>Tracking ID: 1Z0000000000000001 </div>\n\n<div class="row"><div data-component="itemTitle"><a href="/dp/B000000001">Widget Alpha Long Name</a></div><span>Qty: 4</span></div></div>`))!;
  assert.equal(p[0].carrier, 'UPS');
  assert.equal(p[0].items?.[0].quantity, 4);
  assert.equal(p[0].items?.[0].qtyAssumed, undefined);
});

test('tracking page: one package with its item', () => {
  const p = pk(doc(`<div class="pt-delivery-card-trackingId">Tracking ID: TBA000000000001</div><a href="/dp/B000000001">Widget Alpha Long Name</a>`), 'tracking')!;
  assert.equal(p.length, 1);
  assert.equal(p[0].trackingNumber, 'TBA000000000001');
  assert.equal(p[0].items?.[0].title, 'Widget Alpha Long Name');
  assert.equal(p[0].source, 'tracking');
});

test('tracking page: no item links -> items null', () => {
  const p = pk(doc(`<div class="pt-delivery-card-trackingId">Tracking ID: TBA000000000001</div>`), 'tracking')!;
  assert.equal(p[0].items, null);
});

test('existing trackingNumbers field is unchanged by package capture', () => {
  const page = parseAmazonPage(detail(shipment('TBA000000000001', item('Widget Alpha Long Name', 2))), 'detail', DETAIL_URL);
  assert.deepEqual(page.orders[0].trackingNumbers, ['TBA000000000001']);
});
