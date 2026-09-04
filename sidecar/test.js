'use strict';

// Minimal smoke test for the since-date arithmetic — the one piece of
// this sidecar's logic that's pure (no DOM/page dependency) and easy to
// silently break (off-by-one on the overlap buffer under/over-scrapes
// or misses orders on every single run). Run with: node test.js
//
// ponytail: not a framework, not exhaustive — just the smallest thing
// that fails if the date math regresses. The DOM-parsing logic (the bulk
// of amazon.js/walmart.js) is ported verbatim from the extension, which
// has its own history of production use; a full browser-driven test of
// that would need a live Amazon/Walmart session, out of scope here.

process.env.TRACKER_URL = process.env.TRACKER_URL || 'http://localhost:9999';
process.env.TRACKER_USER_ID = process.env.TRACKER_USER_ID || '1';

const assert = require('node:assert');
const { computeAmazonSinceDate, scrapeYear, MAX_CONSECUTIVE_ALL_OLD_PAGES } = require('./src/amazon');
const { computeWalmartSinceDate } = require('./src/walmart');
const {
  computeCostcoSinceDate, mapOrder, formatReceiptDate, receiptsFrom, receiptDetailQuery,
} = require('./src/costco');
const { merchantUrl } = require('./src/cashbackmonitor');

const NOW = new Date('2026-07-30T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

// Amazon: no prior sync → 60-day floor.
{
  const since = computeAmazonSinceDate(null, NOW);
  assert.strictEqual(since.getTime(), NOW.getTime() - 60 * DAY, 'no lastSync should use the 60-day floor');
}

// Amazon: recent lastSync → lastSync minus 1-day overlap buffer, unless
// that's inside the AMAZON_MIN_LOOKBACK_DAYS floor (14 days, see
// sidecar/src/syncWindow.js and lib/syncWindow.test.ts), in which case the
// floor wins. This assertion used a 5-day-old lastSync, which predates
// that floor being added (7ea782f) — updated to a lastSync outside the
// floor so it still actually exercises the overlap-buffer branch instead
// of always hitting the floor.
{
  const lastSync = new Date(NOW.getTime() - 20 * DAY).toISOString();
  const since = computeAmazonSinceDate(lastSync, NOW);
  assert.strictEqual(since.getTime(), new Date(lastSync).getTime() - DAY, 'a lastSync outside the floor should get a 1-day overlap buffer, not be clamped to the floor');
}

// Amazon: recent lastSync (inside the 14-day floor) → the floor wins, not
// the 1-day overlap buffer. This is the regression lib/syncWindow.test.ts
// exists for (order-placed dates within ~48h of "now" used to fall outside
// the window entirely); duplicated here in miniature so this file's own
// Amazon-since-date coverage doesn't silently drift back to pre-floor
// expectations.
{
  const lastSync = new Date(NOW.getTime() - 5 * DAY).toISOString();
  const since = computeAmazonSinceDate(lastSync, NOW);
  assert.strictEqual(since.getTime(), NOW.getTime() - 14 * DAY, 'a lastSync inside the 14-day floor should be clamped to the floor');
}

// Amazon: stale lastSync (older than 60 days) → scan back to it (no floor
// clamp), still less the same 1-day overlap buffer every watermark gets
// (computeSinceDate in syncWindow.js subtracts overlapMs unconditionally,
// before comparing against the floor — this assertion previously expected
// zero overlap, which was already stale independent of the 14-day floor
// added in 7ea782f).
{
  const lastSync = new Date(NOW.getTime() - 90 * DAY).toISOString();
  const since = computeAmazonSinceDate(lastSync, NOW);
  assert.strictEqual(since.getTime(), new Date(lastSync).getTime() - DAY, 'stale lastSync should scan back to it minus the overlap buffer, unclamped by the floor');
}

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

// Amazon: the cancelled/returned/refunded card-text filter (amazon.js
// scrapeDocInBrowser) excludes the product title from the text it tests,
// so a title merely containing one of those words doesn't drop a live
// order. This can't import the real function — it runs inside
// page.evaluate() (see the comment at scrapeDocInBrowser's call site),
// which Playwright serializes via toString() and re-parses standalone in
// the page context, so it can't reference anything outside its own body.
// This mirrors that inline algorithm (title-strip, then regex) so the
// title-exclusion behavior it's meant to add has a regression check; keep
// it in sync with amazon.js by hand if that logic changes.
{
  function isSkippedAsCancelledOrReturned(cardText, titleText) {
    const statusCheckText = titleText ? cardText.split(titleText).join(' ') : cardText;
    return /\b(cancelled|canceled|refunded|returned)\b/i.test(statusCheckText);
  }

  // A genuine status badge outside the title still gets caught.
  assert.strictEqual(
    isSkippedAsCancelledOrReturned('Order placed Jan 1, 2026 Total $19.99 Cancelled Widget Pro', 'Widget Pro'),
    true,
    'a real Cancelled badge outside the title must still be caught',
  );
  assert.strictEqual(
    isSkippedAsCancelledOrReturned('Order placed Jan 1, 2026 Total $19.99 Refunded Widget Pro', 'Widget Pro'),
    true,
    'a real refund notice outside the title must still be caught',
  );
  // A title-only occurrence (the false positive this fix targets) is not.
  assert.strictEqual(
    isSkippedAsCancelledOrReturned('Order placed Jan 1, 2026 Total $19.99 Certified Refurbished Returned-Item Blender', 'Certified Refurbished Returned-Item Blender'),
    false,
    'the word appearing only in the product title must not drop the order',
  );
  // A normal order with neither is unaffected.
  assert.strictEqual(
    isSkippedAsCancelledOrReturned('Order placed Jan 1, 2026 Total $19.99 Widget Pro', 'Widget Pro'),
    false,
    'an ordinary order must not be skipped',
  );
}

// Amazon: scrapeYear pagination. Unlike scrapeDocInBrowser above, scrapeYear
// is Node-side orchestration (not run inside page.evaluate()), so it can be
// imported directly and driven with a mocked `page` object instead of being
// hand-mirrored. The mock dispatches on the in-page function's `.name` --
// scrapeYear always calls page.evaluate(scrapeDocInBrowser, ...) and
// page.evaluate(getNextStartIndexInBrowser), and those functions keep their
// names whether or not they're exported, since page.evaluate receives the
// actual function object.
//
// Bug: order #872 (real Amazon order, confirmed to have a real tracking
// number, well inside the sync window) was never fetched because Amazon's
// order-history list isn't strictly newest-to-oldest -- a page can contain
// an old-dated card ahead of, or on an earlier page than, a genuinely newer
// in-window order. The old scrapeYear stopped pagination the instant ANY
// card on a page was older than sinceDate, so a later page with real
// in-window orders on it was silently never fetched. Fixed: a page only
// stops the walk when it contributes zero in-window orders, and even then
// only after MAX_CONSECUTIVE_ALL_OLD_PAGES consecutive such pages (see the
// constant's comment in sidecar/src/amazon.js for why 3).
function makeMockAmazonPage(pages) {
  let idx = 0;
  let gotoCount = 0;
  const page = {
    async goto() { gotoCount++; },
    url() { return 'https://www.amazon.com/your-orders/orders'; },
    async evaluate(fn) {
      if (fn.name === 'waitForOrdersInBrowser') return true;
      const p = pages[idx];
      if (!p) throw new Error(`mock page ${idx} not defined -- scrapeYear fetched more pages than the test expected`);
      if (fn.name === 'scrapeDocInBrowser') return { orders: p.orders, sawOlder: p.sawOlder, anyInWindow: p.anyInWindow };
      if (fn.name === 'getNextStartIndexInBrowser') { idx++; return p.nextIndex; }
      throw new Error(`unexpected page.evaluate fn: ${fn.name}`);
    },
  };
  return { page, gotoCount: () => gotoCount };
}

async function runAmazonPaginationTests() {
  // 1. The exact reported shape on a SINGLE page: an old card ahead of a
  // newer, in-window card. scrapeDocInBrowser already excludes old cards
  // from its `orders` array (untouched by this fix), so the newer order
  // must come through regardless of on-page position.
  {
    const newOrder = { orderNumber: 'NEW-1', orderDate: '2026-07-25' };
    const { page } = makeMockAmazonPage([
      { orders: [newOrder], sawOlder: true, anyInWindow: true, nextIndex: null },
    ]);
    const allOrders = [];
    const hit = await scrapeYear(page, null, '2026-07-16T00:00:00.000Z', allOrders, new Set());
    assert.deepStrictEqual(allOrders.map(o => o.orderNumber), ['NEW-1'], 'a page mixing an old card with a newer in-window card must still capture the newer order');
    assert.strictEqual(hit, true, 'a page that saw an older card should report having reached sinceDate');
  }

  // 2. The literal "872 was on the next page" scenario: a page that is
  // entirely old, followed by a page with a genuinely newer in-window
  // order. This is the one that actually failed under the old
  // stop-on-first-old-card logic -- see the git-stash proof in the PR
  // description / task report.
  {
    const newOrder = { orderNumber: 'NEW-2', orderDate: '2026-07-20' };
    const { page, gotoCount } = makeMockAmazonPage([
      { orders: [], sawOlder: true, anyInWindow: false, nextIndex: 10 },
      { orders: [newOrder], sawOlder: false, anyInWindow: true, nextIndex: null },
    ]);
    const allOrders = [];
    const hit = await scrapeYear(page, null, '2026-07-16T00:00:00.000Z', allOrders, new Set());
    assert.deepStrictEqual(allOrders.map(o => o.orderNumber), ['NEW-2'], 'pagination must continue past a fully-old page to reach a later page with an in-window order');
    assert.strictEqual(gotoCount(), 2, 'the second page must actually be fetched');
    assert.strictEqual(hit, true, 'having seen an older card earlier in this year should still report reaching sinceDate once the year is exhausted');
  }

  // 3. A page that is genuinely and entirely older than sinceDate, with no
  // further pages at all (natural end of pagination, not the safety cap).
  {
    const { page, gotoCount } = makeMockAmazonPage([
      { orders: [], sawOlder: true, anyInWindow: false, nextIndex: null },
    ]);
    const allOrders = [];
    const hit = await scrapeYear(page, null, '2026-07-16T00:00:00.000Z', allOrders, new Set());
    assert.deepStrictEqual(allOrders, []);
    assert.strictEqual(gotoCount(), 1, 'a genuinely exhausted order list must not keep paginating');
    assert.strictEqual(hit, true);
  }

  // 4. The consecutive-all-old-pages safety cap: an account with endless
  // old history must not be walked forever. The mock offers a couple more
  // pages than the cap allows, so a regression here shows up as "fetched
  // more pages than expected" rather than a silent infinite loop. (True
  // alternation between old and new pages resets the consecutive counter
  // by design -- see anyInWindow -- so it never trips the cap on its own;
  // this test is specifically the do-nothing-but-old run.)
  {
    const pages = [];
    for (let i = 0; i < MAX_CONSECUTIVE_ALL_OLD_PAGES + 2; i++) {
      pages.push({ orders: [], sawOlder: true, anyInWindow: false, nextIndex: 10 * (i + 1) });
    }
    const { page, gotoCount } = makeMockAmazonPage(pages);
    const allOrders = [];
    const hit = await scrapeYear(page, null, '2026-07-16T00:00:00.000Z', allOrders, new Set());
    assert.strictEqual(gotoCount(), MAX_CONSECUTIVE_ALL_OLD_PAGES, `must stop after exactly ${MAX_CONSECUTIVE_ALL_OLD_PAGES} consecutive all-old pages`);
    assert.strictEqual(hit, true);
  }
}

runAmazonPaginationTests().then(() => {
  console.log('sidecar/test.js: all checks passed');
}).catch(err => {
  console.error(err);
  process.exit(1);
});
