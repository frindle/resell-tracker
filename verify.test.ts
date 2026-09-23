// Adversarial cases for: rt-walmart-delivered-signal-wiring-v2   (node --test / tsx --test)
//
// THE CONFIRMED GAP (main @ 03009d6): sidecar/src/walmart.js:442-444 fabricates
// the order-number tracking placeholder UNCONDITIONALLY whenever no carrier
// number is scraped; extractDetailInBrowser derives isStoreDelivery but no
// isDelivered signal exists anywhere in the file; and the decision module
// sidecar/src/walmartTracking.js (resolveWalmartTracking) is dead code that
// nothing imports.
//
// These cases pin:
//   - detectWalmartFulfillment's two independent booleans against the exact
//     premature-fallback case ('Delivery from store' alone), the substring
//     trap ('Delivery' must NEVER read as 'Delivered'), negated text, and the
//     order-number-scoped caption-id forms;
//   - a STRUCTURAL WIRING PIN on walmart.js (it cannot be driven in a unit
//     test -- it pulls in playwright): the fallback is routed through
//     resolveWalmartTracking with all four inputs, its result is unwrapped to
//     an array, the unconditional regression line is gone, and the browser-side
//     isDelivered regex is extracted from the source and driven against the
//     same trap cases (so it is behaviourally pinned, not just present).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { detectWalmartFulfillment, STORE_DELIVERY_RE, DELIVERED_RE } from './sidecar/src/walmartDetailSignals.js';
import { resolveWalmartTracking } from './sidecar/src/walmartTracking.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const WALMART_JS = join(HERE, 'sidecar', 'src', 'walmart.js');
const walmartSrc = () => readFileSync(WALMART_JS, 'utf8');

// --- degenerate inputs: must not throw, both flags false -------------------

test('null / undefined / empty html -> both flags false, no throw', () => {
  assert.deepEqual(detectWalmartFulfillment(null), { isStoreDelivery: false, isDelivered: false });
  assert.deepEqual(detectWalmartFulfillment(undefined), { isStoreDelivery: false, isDelivered: false });
  assert.deepEqual(detectWalmartFulfillment(''), { isStoreDelivery: false, isDelivered: false });
  assert.deepEqual(detectWalmartFulfillment(null, '5034976218'), { isStoreDelivery: false, isDelivered: false });
});

// --- THE premature-fallback case -------------------------------------------
// 'Delivery from store' alone sets isStoreDelivery true and isDelivered FALSE.
// A store delivery that has not arrived yet can still be re-routed to
// UPS/FedEx -- it must never read as delivered.

test("'Delivery from store' -> isStoreDelivery true, isDelivered false (premature-fallback case)", () => {
  const r = detectWalmartFulfillment('<div>Delivery from store</div>');
  assert.equal(r.isStoreDelivery, true);
  assert.equal(r.isDelivered, false);
});

// --- the substring trap -----------------------------------------------------
// 'Delivery' must NEVER satisfy DELIVERED_RE. A naive /deliver/i build passes
// every other case and fails exactly these.

test("substring trap: 'Estimated delivery' alone -> both false", () => {
  const r = detectWalmartFulfillment('<span>Estimated delivery by Friday</span>');
  assert.deepEqual(r, { isStoreDelivery: false, isDelivered: false });
});

test('DELIVERED_RE does not match the word "Delivery" itself', () => {
  assert.ok(!DELIVERED_RE.test('Delivery from store'));
  assert.ok(!DELIVERED_RE.test('Estimated delivery'));
  assert.ok(DELIVERED_RE.test('Delivered Sep 21, 2026'));
});

// --- negated text must not read as delivered ---------------------------------

test("negations: 'Not delivered', 'Not yet delivered', 'Delivery date' -> isDelivered false", () => {
  for (const html of ['<p>Not delivered</p>', '<p>Not yet delivered</p>', '<p>Delivery date: Sep 21, 2026</p>']) {
    const r = detectWalmartFulfillment(html);
    assert.equal(r.isDelivered, false, `expected isDelivered=false for ${html}`);
  }
});

// --- the terminal state ------------------------------------------------------

test("'Delivered Sep 21, 2026' -> isDelivered true, isStoreDelivery false", () => {
  const r = detectWalmartFulfillment('<div>Delivered Sep 21, 2026</div>');
  assert.deepEqual(r, { isStoreDelivery: false, isDelivered: true });
});

// --- caption-id forms: order-number-scoped -----------------------------------

test('caption-id forms are order-number-scoped (orderNumber 5034976218)', () => {
  const delivered = detectWalmartFulfillment('<div id="caption-5034976218-Delivered">x</div>', '5034976218');
  assert.equal(delivered.isDelivered, true);

  const store = detectWalmartFulfillment('<div id="caption-5034976218-Delivery_from_store">x</div>', '5034976218');
  assert.equal(store.isStoreDelivery, true);
  assert.equal(store.isDelivered, false);

  // A caption for a DIFFERENT order number must not fire this order's flags.
  const other = detectWalmartFulfillment('<div id="caption-9999999999-Delivered">x</div>', '5034976218');
  assert.equal(other.isDelivered, false);
  const otherStore = detectWalmartFulfillment('<div id="caption-9999999999-Delivery_from_store">x</div>', '5034976218');
  assert.equal(otherStore.isStoreDelivery, false);
});

// --- independence of the two flags -------------------------------------------

test('both markers -> both true; neither marker -> both false', () => {
  const both = detectWalmartFulfillment('<div>Delivery from store</div><div>Delivered Sep 21, 2026</div>');
  assert.deepEqual(both, { isStoreDelivery: true, isDelivered: true });

  const neither = detectWalmartFulfillment('<div>Your order is on its way. Estimated delivery by Friday.</div>');
  assert.deepEqual(neither, { isStoreDelivery: false, isDelivered: false });
});

// --- case-insensitivity and whitespace tolerance ------------------------------

test('case-insensitive and tolerant of collapsed/expanded whitespace', () => {
  const lower = detectWalmartFulfillment('<div>delivery from store</div>');
  assert.equal(lower.isStoreDelivery, true);
  assert.equal(lower.isDelivered, false);

  const expanded = detectWalmartFulfillment('<div>Delivery   \n\t from    store</div>');
  assert.equal(expanded.isStoreDelivery, true);

  const lowerDelivered = detectWalmartFulfillment('<div>delivered Sep 21, 2026</div>');
  assert.equal(lowerDelivered.isDelivered, true);
});

// --- STORE_DELIVERY_RE is a pure lift of walmart.js:251 -----------------------

test('STORE_DELIVERY_RE keeps matching exactly /Delivery\\s+from\\s+store/i on plain text', () => {
  const baseline = (s: string) => /Delivery\s+from\s+store/i.test(s);
  for (const s of ['Delivery from store', 'delivery   from STORE', 'Delivery\nfrom store', 'Delivered Sep 21, 2026', 'Estimated delivery', 'Delivery_from_store_x']) {
    assert.equal(STORE_DELIVERY_RE.test(s), baseline(s), `STORE_DELIVERY_RE diverged from walmart.js:251 on ${JSON.stringify(s)}`);
  }
  // ...and additionally accepts the caption-id form.
  assert.ok(STORE_DELIVERY_RE.test('id="caption-5034976218-Delivery_from_store"'));
});

// --- END-TO-END DECISION: signals feed resolveWalmartTracking ----------------
// The two modules together must produce the intended trackingNumbers, using
// the exact unwrap the call site is required to use (`.trackingNumbers ?? []`).

test('signals -> resolveWalmartTracking: pending store delivery gets [], delivered store delivery gets order number, carrier wins', () => {
  const decide = (html: string, scraped: string[]) => {
    const { isStoreDelivery, isDelivered } = detectWalmartFulfillment(html, '5034976218');
    return resolveWalmartTracking({ orderNumber: '5034976218', scrapedTracking: scraped, isStoreDelivery, isDelivered }).trackingNumbers ?? [];
  };
  // premature-fallback case: store delivery, not yet delivered -> NOTHING
  assert.deepEqual(decide('<div>Delivery from store</div>', []), []);
  // non-store order with no tracking yet -> NOTHING (not the order number)
  assert.deepEqual(decide('<div>Estimated delivery by Friday</div>', []), []);
  // delivered store delivery -> the digits-only order number placeholder
  assert.deepEqual(decide('<div>Delivery from store</div><div>Delivered Sep 21, 2026</div>', []), ['5034976218']);
  // a real carrier number always wins, delivered or not
  assert.deepEqual(decide('<div>Delivery from store</div>', ['1Z999AA10123456784']), ['1Z999AA10123456784']);
});

// --- STRUCTURAL WIRING PIN (walmart.js cannot be driven -- it pulls playwright)

test('walmart.js imports the decision module and routes the fallback through it with all four inputs', () => {
  const src = walmartSrc();
  assert.ok(src.includes("require('./walmartTracking')"),
    "walmart.js must import resolveWalmartTracking from './walmartTracking'");
  assert.ok(src.includes('resolveWalmartTracking({'),
    'walmart.js must call resolveWalmartTracking(...) rather than inlining the fallback');
  for (const input of ['orderNumber: order.orderNumber', 'scrapedTracking: filteredTracking', 'isStoreDelivery: detail.isStoreDelivery', 'isDelivered: detail.isDelivered']) {
    assert.ok(src.includes(input), `resolveWalmartTracking call site must pass ${input}`);
  }
  assert.ok(src.includes('.trackingNumbers ?? []'),
    'the call site must unwrap .trackingNumbers and map null to [] (trackingNumbers stays an array)');
});

test('the unconditional order-number regression line is GONE from walmart.js', () => {
  const src = walmartSrc();
  assert.ok(!src.includes("else order.trackingNumbers = [order.orderNumber.replace("),
    "walmart.js must no longer contain the bare fallback 'else order.trackingNumbers = [order.orderNumber.replace('");
  assert.ok(!src.includes("order.trackingNumbers = [order.orderNumber.replace("),
    'walmart.js must not fabricate the order-number placeholder inline anywhere');
});

test('extractDetailInBrowser returns isDelivered alongside isStoreDelivery, and line 251 is untouched', () => {
  const src = walmartSrc();
  assert.ok(/return\s*\{[^}]*isStoreDelivery[^}]*isDelivered|return\s*\{[^}]*isDelivered[^}]*isStoreDelivery/s.test(src),
    'the detail object returned by extractDetailInBrowser must carry isDelivered alongside isStoreDelivery');
  assert.ok(src.includes('const isStoreDelivery = /Delivery\\s+from\\s+store/i.test(html);'),
    'walmart.js:251 (isStoreDelivery) must be left exactly as it is -- pure lift, no behaviour change');
});

test('the browser-side isDelivered regex in walmart.js rejects the substring trap and accepts the terminal forms', () => {
  const src = walmartSrc();
  // page.evaluate cannot require(), so walmart.js mirrors DELIVERED_RE inline.
  // Extract that regex literal and DRIVE it, so a mutated/naive pattern fails.
  const m = /const isDelivered = \/((?:\\.|[^\/\n])+)\/([a-z]*)\.test\(html\)/.exec(src);
  assert.ok(m, "walmart.js must derive `const isDelivered = /<pattern>/<flags>.test(html)` inside extractDetailInBrowser");
  const re = new RegExp(m![1], m![2]);
  for (const s of ['Delivery from store', 'Estimated delivery by Friday', 'Not yet delivered', 'Delivery date: Sep 21, 2026']) {
    assert.equal(re.test(s), false, `browser-side isDelivered regex must NOT match ${JSON.stringify(s)}`);
  }
  for (const s of ['Delivered Sep 21, 2026', 'delivered Sep 21, 2026', 'id="caption-5034976218-Delivered"']) {
    assert.equal(re.test(s), true, `browser-side isDelivered regex must match ${JSON.stringify(s)}`);
  }
});
