import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { parseAmazonPage } from './amazonPageParse.ts';

// All fixtures are synthetic: fake order numbers, names and addresses.
const doc = (html: string) => parseHTML(`<!doctype html><html><body>${html}</body></html>`).document as unknown as Document;
const LIST_URL = 'https://www.amazon.com/your-orders/orders?timeFilter=last30';

const card = (o: { id: string; date: string; total?: string; ship?: string; status: string; title: string; grid?: boolean }) => `
<div class="order-card js-order-card">
  <div class="a-box-inner"><div class="order-header">
    <div class="a-column"><span class="a-text-caps">Order placed</span><span>${o.date}</span></div>
    ${o.total ? `<div class="a-column"><span class="a-text-caps">Total</span><span>${o.total}</span></div>` : ''}
    ${o.ship ? `<div class="a-column"><span class="a-text-caps">Ship to</span><span id="shipToInsertionNode-shippingAddress-x">${o.ship} United States</span></div>` : ''}
    <div class="a-column yohtmlc-order-id"><span class="a-text-caps">Order #</span><span dir="ltr">${o.id}</span></div>
    <a href="/gp/your-account/order-details?orderID=${o.id}">View order details</a>
  </div></div>
  <div class="delivery-box"><span class="delivery-box__primary-text">${o.status}</span></div>
  ${o.grid
    ? `<div class="yo-enhanced-flex"><div class="yo-enhanced-flex-card"><div class="yo-enhanced-title"><a href="/dp/B000000001">${o.title}</a></div></div></div>`
    : `<div class="item-box"><div class="yohtmlc-product-title"><a href="/dp/B000000001">${o.title}</a></div></div>`}
</div>`;

test('order list: label-based fields, grid layout, cancelled card without Total/Ship To', () => {
  const html = card({ id: '111-2222222-3333331', date: 'November 10, 2026', total: '$54.30', ship: '100 Example St, Testville, ZZ 00000', status: 'Arriving tomorrow', title: 'Widget Alpha' })
    + card({ id: '111-2222222-3333332', date: 'November 9, 2026', status: 'Cancelled', title: 'Widget Cancelled' })
    + card({ id: '111-2222222-3333333', date: 'November 8, 2026', total: '$12.00', ship: '100 Example St, Testville, ZZ 00000', status: 'Delivered', title: 'Widget Grid', grid: true });
  const p = parseAmazonPage(doc(html), 'orders', LIST_URL);
  assert.equal(p.blocked, false);
  assert.deepEqual(p.orders.map(o => o.orderNumber), ['111-2222222-3333331', '111-2222222-3333333']);
  assert.equal(p.orders[0].cost, 54.3);
  assert.equal(p.orders[0].orderDate, '2026-11-10');
  assert.equal(p.orders[0].itemDescription, 'Widget Alpha');
  assert.match(p.orders[0].shippingAddress ?? '', /^100 Example St/);
  assert.equal(p.orders[1].itemDescription, 'Widget Grid');
  assert.equal(p.orders[1].cost, 12);
  assert.equal(p.oldestDate, '2026-11-08');
});

test('order list: missing Total is undefined, not a neighbouring column', () => {
  const html = card({ id: '111-2222222-3333334', date: 'November 7, 2026', status: 'Arriving', title: 'No Total Item' });
  const p = parseAmazonPage(doc(html), 'orders', LIST_URL);
  assert.equal(p.orders[0].cost, undefined);
  assert.equal(p.orders[0].shippingAddress, undefined);
});

test('order list: empty page that is not an empty account is flagged parseFailed', () => {
  const p = parseAmazonPage(doc('<div>nothing here</div>'), 'orders', LIST_URL);
  assert.equal(p.parseFailed, true);
});

const detail = (opts: { rate: string; tax?: string; total?: string }) => `
<div id="orderDetails" class="order-details">
 <div data-component="orderId">Order # 111-2222222-3333331</div>
 <div data-component="orderDate">Ordered on November 10, 2026</div>
 <div data-component="shippingAddress"><div>Ship to</div><div>Pat Example</div><div>100 Example St</div><div>Testville, ZZ 00000</div></div>
 <div data-component="purchasedItems"><div data-component="itemTitle"><a href="/dp/B000000001">Widget Alpha Long Name</a></div></div>
 <div data-component="aapiPaymentMethods"><div aria-label="payment method"><span>Prime Store Card</span><span>•••• 1234</span><span>${opts.rate}</span></div></div>
 <div data-component="chargeSummary">${opts.tax ? `<div>Estimated tax to be collected: ${opts.tax}</div>` : ''}<div>Grand Total: ${opts.total ?? '$54.30'}</div></div>
 <a href="/progress-tracker/package?orderId=111-2222222-3333331&shipmentId=s1">Track package</a>
</div>`;
const DETAIL_URL = 'https://www.amazon.com/your-orders/order-details?orderID=111-2222222-3333331';

test('detail: Prime Store Card 5% + extra 1% = 6, tax, total, address, date', () => {
  const p = parseAmazonPage(doc(detail({ rate: 'Earns 5% back and extra 1% with No-Rush Shipping', tax: '$3.80' })), 'detail', DETAIL_URL);
  const o = p.orders[0];
  assert.equal(o.paymentLast4, '1234');
  assert.equal(o.paymentRatePercent, 6);
  assert.equal(o.cost, 54.3);
  assert.equal(o.taxAmount, 3.8);
  assert.equal(o.orderDate, '2026-11-10');
  assert.match(o.shippingAddress ?? '', /100 Example St/);
  assert.equal(o.itemDescription, 'Widget Alpha Long Name');
  assert.equal(o.trackUrls.length, 1);
});

test('detail: "Get X% back" phrasing', () => {
  const p = parseAmazonPage(doc(detail({ rate: 'Get 5% back' })), 'detail', DETAIL_URL);
  assert.equal(p.orders[0].paymentRatePercent, 5);
});

test('detail: absent tax is null, never 0', () => {
  const p = parseAmazonPage(doc(detail({ rate: 'Get 5% back' })), 'detail', DETAIL_URL);
  assert.equal(p.orders[0].taxAmount, null);
  assert.equal(p.orders[0].subtotalAmount, null);
});

const TRACK_URL = 'https://www.amazon.com/progress-tracker/package?orderId=111-2222222-3333331&shipmentId=s1&packageIndex=0';

test('tracking page: .pt-delivery-card-trackingId, label stripped', () => {
  const p = parseAmazonPage(doc('<div class="pt-delivery-card-trackingId">Tracking ID: TBA123456789012</div>'), 'tracking', TRACK_URL);
  assert.equal(p.orders[0].orderNumber, '111-2222222-3333331');
  assert.deepEqual(p.orders[0].trackingNumbers, ['TBA123456789012']);
});

test('tracking page: unshipped order is "no tracking yet", not a parse failure', () => {
  const p = parseAmazonPage(doc('<div class="pt-status-main-status">Ordered</div>'), 'tracking', TRACK_URL);
  assert.equal(p.orders.length, 0);
  assert.equal(p.noTrackingYet, true);
  assert.notEqual(p.parseFailed, true);
});

test('blocked pages yield no data', () => {
  const signin = parseAmazonPage(doc('<form name="signIn"><input id="ap_email"></form>'), 'orders', LIST_URL);
  assert.equal(signin.blocked, true); assert.equal(signin.blockReason, 'sign-in'); assert.equal(signin.orders.length, 0);
  const cap = parseAmazonPage(doc('<form action="/errors/validateCaptcha"></form>'), 'detail', DETAIL_URL);
  assert.equal(cap.blockReason, 'captcha');
  const agent = parseAmazonPage(doc("<p>Use of an unauthorized AI agent violates Amazon's Conditions of Use</p>"), 'orders', LIST_URL);
  assert.equal(agent.blockReason, 'agent-block'); assert.equal(agent.orders.length, 0);
});
