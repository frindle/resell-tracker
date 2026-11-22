'use strict';

// Minimal smoke test for the since-date arithmetic — the one piece of
// this sidecar's logic that's pure (no DOM/page dependency) and easy to
// silently break (off-by-one on the overlap buffer under/over-scrapes
// or misses orders on every single run). Run with: node test.js
//
// ponytail: not a framework, not exhaustive — just the smallest thing
// that fails if the date math regresses. The DOM-parsing logic (the bulk
// of walmart.js/costco.js) is ported verbatim from the extension, which
// has its own history of production use; a full browser-driven test of
// that would need a live Walmart/Costco session, out of scope here.

process.env.TRACKER_URL = process.env.TRACKER_URL || 'http://localhost:9999';
process.env.TRACKER_USER_ID = process.env.TRACKER_USER_ID || '1';

const assert = require('node:assert');
const { computeWalmartSinceDate } = require('./src/walmart');
const {
  computeCostcoSinceDate, mapOrder, formatReceiptDate, receiptsFrom, receiptDetailQuery,
  mapOrderDetails, costcoCardLast4, costcoShipAddress, costcoInterceptorSource,
} = require('./src/costco');
const { merchantUrl } = require('./src/cashbackmonitor');

const NOW = new Date('2026-07-30T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

// Walmart: no prior sync → 30-day floor.
{
  const since = computeWalmartSinceDate(null, NOW);
  assert.strictEqual(since.getTime(), NOW.getTime() - 30 * DAY, 'no lastSync should use the 30-day floor');
}

// Walmart: prior sync → lastSync minus 48h overlap buffer. (lastSync is
// kept outside the 14-day min-lookback floor so this actually exercises
// the overlap-buffer branch instead of always hitting the floor.)
{
  const lastSync = new Date(NOW.getTime() - 30 * DAY).toISOString();
  const since = computeWalmartSinceDate(lastSync, NOW);
  assert.strictEqual(since.getTime(), new Date(lastSync).getTime() - 48 * 60 * 60 * 1000, 'lastSync should get a 48h overlap buffer');
}

// Costco: no prior sync → 90-day floor (the extension's own default).
{
  const since = computeCostcoSinceDate(null, NOW);
  assert.strictEqual(since.getTime(), NOW.getTime() - 90 * DAY, 'no lastSync should use the 90-day floor');
}

// Costco: prior sync → lastSync minus a 1-day overlap buffer. (lastSync is
// kept outside the 14-day min-lookback floor so this actually exercises
// the overlap-buffer branch instead of always hitting the floor.)
{
  const lastSync = new Date(NOW.getTime() - 30 * DAY).toISOString();
  const since = computeCostcoSinceDate(lastSync, NOW);
  assert.strictEqual(since.getTime(), new Date(lastSync).getTime() - DAY, 'lastSync should get a 1-day overlap buffer');
}

// Costco: an unparseable stored lastSync must fall back to the floor, not
// produce an Invalid Date that silently makes every comparison false.
{
  const since = computeCostcoSinceDate('not-a-date', NOW);
  assert.strictEqual(since.getTime(), NOW.getTime() - 90 * DAY, 'garbage lastSync should fall back to the floor');
}

// Costco order mapping: cancelled orders and cancelled line items drop
// out, and electronic-delivery "tracking" is not real tracking.
{
  assert.strictEqual(mapOrder({ status: 'Cancelled', orderLineItems: [] }), null, 'cancelled orders are skipped');

  const mapped = mapOrder({
    orderNumber: '123456',
    orderPlacedDate: '2026-07-01T10:00:00Z',
    orderTotal: 42.5,
    status: 'Shipped',
    orderLineItems: [
      { itemDescription: 'Widget', status: 'Shipped', shipment: [{ trackingNumber: '1Z999', carrierName: 'UPS' }] },
      { itemDescription: 'Gift Card', status: 'Shipped', shipment: [{ trackingNumber: 'EMAILED', carrierName: 'Email Delivery' }] },
      { itemDescription: 'Dropped', status: 'Canceled', shipment: [{ trackingNumber: '9400111', carrierName: 'USPS' }] },
    ],
  });
  assert.strictEqual(mapped.platform, 'Costco');
  assert.strictEqual(mapped.orderDate, '2026-07-01', 'orderDate is the date half of orderPlacedDate');
  assert.deepStrictEqual(mapped.trackingNumbers, ['1Z999'], 'digital-delivery and cancelled-item tracking must be excluded');
  assert.strictEqual(mapped.itemDescription, 'Widget, Gift Card', 'cancelled line items drop out of the description');
}

// Costco order details (SYNC_COSTCO_ORDER). Synthetic data in the shape of
// the captured getOrderDetails response (sidecar/costco-order-details-capture.md):
// the ship-to address, not the billing one; the card's last four, not a coupon
// id; the order total after discounts.
{
  const detail = {
    orderNumber: '1330000099',
    orderPlacedDate: '2026-11-17T08:00:00',
    status: 'Order Received',
    orderTotal: 420,
    orderPayment: [
      { paymentType: 'Visa', totalCharged: 420, cardNumber: '4242', isGOMPayment: false },
      { paymentType: 'Coupon', totalCharged: 40, cardNumber: '1234567', isGOMPayment: false },
      { paymentType: 'Coupon', totalCharged: 40, cardNumber: '7654321', isGOMPayment: false },
    ],
    shipToAddress: [{
      firstName: 'Test', lastName: 'Buyer', line1: '1 Example Way', line2: 'Suite 9', line3: '',
      city: 'Springfield', state: 'ZZ', postalCode: '00001-0001', countryCode: 'US', isShipToWarehouse: false,
      orderLineItems: [
        { orderStatus: 'Order Placed', itemDescription: 'Brand 65" Class TV', shipment: [] },
        { orderStatus: 'Order Placed', itemDescription: 'Brand 65" Class TV', shipment: [] },
        { orderStatus: 'Cancelled', itemDescription: 'Dropped Item', shipment: [{ trackingNumber: '1Z999', carrierName: 'UPS' }] },
      ],
    }],
  };
  const row = mapOrderDetails(detail);
  assert.strictEqual(row.platform, 'Costco');
  assert.strictEqual(row.orderNumber, '1330000099');
  assert.strictEqual(row.orderDate, '2026-11-17');
  assert.strictEqual(row.cost, 420, 'cost is the order total after discounts');
  assert.strictEqual(row.shippingAddress, 'Test Buyer, 1 Example Way, Suite 9, Springfield, ZZ 00001-0001');
  assert.strictEqual(row.paymentLast4, '4242', 'the card, never a coupon id');
  assert.strictEqual(row.itemDescription, 'Brand 65" Class TV', 'one description per distinct item; cancelled lines drop out');
  assert.deepStrictEqual(row.trackingNumbers, [], 'tracking from a cancelled line is not the order\'s');
  assert.strictEqual(row.merchandiseSubtotal, undefined, 'no merchandise total, no subtotal');
  // The Costco Executive reward's base: merchandise less discounts, before tax and shipping.
  assert.strictEqual(mapOrderDetails({ ...detail, merchandiseTotal: 500, discountAmount: 80 }).merchandiseSubtotal, 420);
  assert.strictEqual(mapOrderDetails({ ...detail, merchandiseTotal: '500.10', discountAmount: -80 }).merchandiseSubtotal, 420.1);
  assert.strictEqual(mapOrderDetails({ ...detail, merchandiseTotal: 50, discountAmount: 80 }).merchandiseSubtotal, 0);
  assert.strictEqual(mapOrderDetails({ ...detail, merchandiseTotal: 'n/a' }).merchandiseSubtotal, undefined);

  assert.strictEqual(mapOrderDetails({ ...detail, status: 'Cancelled' }), null, 'cancelled orders are skipped');
  assert.strictEqual(mapOrderDetails(null), null);

  // No card at all (shop card or coupons only), a masked number, a split payment.
  assert.strictEqual(costcoCardLast4([{ paymentType: 'Costco Shop Card', totalCharged: 10, cardNumber: '1111' }]), undefined);
  assert.strictEqual(costcoCardLast4([{ paymentType: 'Mastercard', totalCharged: 10, cardNumber: '************5555' }]), '5555');
  assert.strictEqual(costcoCardLast4([
    { paymentType: 'Visa', totalCharged: 50, cardNumber: '1111' },
    { paymentType: 'Mastercard', totalCharged: 900, cardNumber: '2222' },
  ]), '2222', 'a split payment takes the card that paid the most');
  assert.strictEqual(costcoCardLast4([{ paymentType: 'Visa', totalCharged: 5, cardNumber: '1111', isGOMPayment: true }]), undefined);

  // Pickup at a warehouse has no ship-to address to report.
  assert.strictEqual(costcoShipAddress([{ isShipToWarehouse: true, line1: '1 Warehouse Rd', city: 'X', state: 'ZZ' }]), '');
  assert.strictEqual(costcoShipAddress([]), '');

  // Real tracking survives; e-mail delivery does not.
  const shipped = mapOrderDetails({ ...detail, shipToAddress: [{ ...detail.shipToAddress[0], orderLineItems: [
    { orderStatus: 'Shipped', itemDescription: 'A', shipment: [{ trackingNumber: '1Z999AA10123456784', carrierName: 'UPS' }] },
    { orderStatus: 'Shipped', itemDescription: 'B', shipment: [{ trackingNumber: 'EMAILED', carrierName: 'Email Delivery' }] },
  ] }] });
  assert.deepStrictEqual(shipped.trackingNumbers, ['1Z999AA10123456784']);

  // The interceptor keeps the details page's own response, keyed by digits.
  const win = { fetch: async () => ({}) };
  const listeners = {};
  function FakeXHR() {}
  FakeXHR.prototype.open = function () {};
  FakeXHR.prototype.setRequestHeader = function () {};
  FakeXHR.prototype.send = function () {};
  FakeXHR.prototype.addEventListener = function (ev, fn) { listeners[ev] = fn.bind(this); };
  new Function('window', 'XMLHttpRequest', `(${costcoInterceptorSource().toString()})()`)(win, FakeXHR);
  const xhr = new FakeXHR();
  xhr.open('POST', 'https://ecom-api.costco.com/ebusiness/order/v1/orders/graphql');
  xhr.send('{}');
  xhr.status = 200;
  xhr.responseText = JSON.stringify({ data: { getOrderDetails: detail } });
  listeners.load();
  assert.strictEqual(win.__costcoOrderDetails['1330000099'].orderTotal, 420, 'details captured by order number');
}

// Costco receipt date format. This is the single easiest thing to get
// wrong in the whole receipts path: the receipts endpoint wants
// "6/01/2026" — single-digit MONTH, zero-padded DAY — which is exactly
// what a %m/%d/%Y formatter does NOT produce. Observed on the wire, see
// sidecar/costco-receipts-capture.md.
{
  assert.strictEqual(formatReceiptDate(new Date(2026, 5, 1)), '6/01/2026', 'month must NOT be zero-padded, day MUST be');
  assert.strictEqual(formatReceiptDate(new Date(2026, 11, 25)), '12/25/2026', 'a two-digit month stays two digits');
  assert.strictEqual(formatReceiptDate(new Date(2026, 0, 9)), '1/09/2026');
}

// receiptsWithCounts is an OBJECT with .receipts, unlike getOnlineOrders
// which is array-wrapped. Getting this backwards silently yields zero
// receipts rather than an error, so pin both shapes.
{
  assert.deepStrictEqual(receiptsFrom({ receiptsWithCounts: { receipts: [{ transactionBarcode: 'A' }] } }), [{ transactionBarcode: 'A' }]);
  assert.deepStrictEqual(receiptsFrom({ receiptsWithCounts: [{ receipts: [{ transactionBarcode: 'B' }] }] }), [{ transactionBarcode: 'B' }], 'array-wrapped shape is tolerated too');
  assert.deepStrictEqual(receiptsFrom({}), []);
  assert.deepStrictEqual(receiptsFrom(null), []);
}

// The detail query's two selection sets must differ by exactly the two
// unconfirmed fields, and both must carry the confirmed ones.
{
  const rich = receiptDetailQuery({ includeUnconfirmed: true });
  const strict = receiptDetailQuery({ includeUnconfirmed: false });
  assert.ok(rich.includes('instantSavings') && rich.includes('membershipNumber'));
  assert.ok(!strict.includes('instantSavings') && !strict.includes('membershipNumber'));
  for (const q of [rich, strict]) {
    assert.ok(q.includes('$barcode: String!'), 'detail signature must take $barcode');
    assert.ok(q.includes('$documentType:String!'), 'detail signature must take $documentType');
    assert.ok(q.includes('transactionBarcode') && q.includes('total') && q.includes('itemArray'));
    assert.ok(!q.includes('...'), 'the capture doc abbreviates with "..." — that must never reach a real query');
  }
}

// CBM slug construction — the extension built this same URL when opening
// the tab, and a wrong slug silently scrapes a 404 page for zero rates.
{
  assert.strictEqual(
    merchantUrl('Best Buy'),
    'https://www.cashbackmonitor.com/cashback-store/best-buy/?vendor=Best%20Buy',
  );
  assert.strictEqual(
    merchantUrl("Sam's Club"),
    // encodeURIComponent leaves an apostrophe unescaped — same URL the
    // extension produced, which is the bar here.
    "https://www.cashbackmonitor.com/cashback-store/sams-club/?vendor=Sam's%20Club",
  );
}

// Costco confirmLoggedIn: the in-page function runs against stubbed
// window/document globals through a fake page whose evaluate(fn) calls fn().
async function runCostcoConfirmLoggedInTests() {
  const { confirmLoggedIn } = require('./src/costco');
  const el = text => ({ textContent: text });
  const withDom = async ({ auth, links = [], all = [] }, fn) => {
    const g = globalThis;
    const had = { window: 'window' in g, document: 'document' in g };
    const saved = { window: g.window, document: g.document };
    g.window = auth ? { __costcoAuth: auth } : {};
    g.document = {
      querySelectorAll: sel => (sel.startsWith('a[href*="/myaccount/"]') ? links : all),
    };
    try { return await fn({ evaluate: f => Promise.resolve().then(f) }); }
    finally {
      for (const k of ['window', 'document']) { if (had[k]) g[k] = saved[k]; else delete g[k]; }
    }
  };
  const run = dom => withDom(dom, page => confirmLoggedIn(page));

  assert.strictEqual(await run({ auth: { token: 'x' } }), true, '__costcoAuth fast path');
  assert.strictEqual(await run({ links: [el('My Orders')] }), true, 'myaccount My Orders link');
  assert.strictEqual(await run({ links: [el('Membership Details')] }), true, 'myaccount Membership link');
  assert.strictEqual(await run({ all: [el('Hello, Penn')] }), true, 'greeting');
  assert.strictEqual(await run({ all: [el('Hi, Penn')] }), true, 'Hi greeting');
  assert.strictEqual(await run({ all: [el('Sign Out')] }), true, 'sign out');
  assert.strictEqual(await run({ all: [el('Log out')] }), true, 'log out');
  // logged-out page: nav shows sign-in, an unrelated myaccount link, nothing else
  assert.strictEqual(await run({ links: [el('Help')], all: [el('Sign In / Register'), el('Hello there')] }), false, 'logged-out page');
  assert.strictEqual(await run({}), false, 'empty page');
  // never throws, sync or async, when evaluate fails
  assert.strictEqual(await confirmLoggedIn({ evaluate: () => Promise.reject(new Error('closed')) }), false);
  assert.strictEqual(await confirmLoggedIn({ evaluate: () => { throw new Error('closed'); } }), false);

  // loginFlow must use it instead of the inline __costcoAuth-only lambda.
  const { SITE_CONFIG } = require('./src/loginFlow');
  assert.strictEqual(SITE_CONFIG.costco.confirmLoggedIn, confirmLoggedIn);
}

Promise.resolve().then(runCostcoConfirmLoggedInTests).then(() => {
  console.log('sidecar/test.js: all checks passed');
}).catch(err => {
  console.error(err);
  process.exit(1);
});
