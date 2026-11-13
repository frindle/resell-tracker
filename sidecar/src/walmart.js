'use strict';

// Ported from resell-tracker-extension/src/content/walmart.ts. Same
// approach as amazon.js: DOM/regex parsing copied near-verbatim and run
// via page.evaluate() against the real page.
//
// Differences from the extension, and why:
//  - The original fetched each order's detail HTML via fetch(orderUrl,
//    {credentials:'include'}) from the content script (to avoid
//    navigating the visible list-page tab away mid-scrape) and parsed it
//    with DOMParser, using both the raw HTML string (regex over <script>
//    tags) and a synthetic `doc`. Here the list is fully scraped into an
//    array *before* any detail fetch begins (same two-phase structure as
//    the original), so navigating the one page we own for each detail
//    page is safe and simpler — page.goto() gives an already-hydrated
//    `document` (Walmart's own React app renders it), which is a
//    superset of what DOMParser-on-fetched-HTML gave the extension.
//    document.documentElement.outerHTML stands in for the original's
//    `html` string for the raw-HTML regex fallbacks.
//  - Detail fetches run sequentially instead of the extension's
//    CONCURRENCY=3 (a single Playwright `page` can't navigate to 3 URLs
//    at once). ponytail: sequential is simpler and correct; add
//    concurrency via multiple browser pages from the same context if
//    sync throughput on large order histories becomes a problem.
//  - The delivery-photo byte fetch used chrome.runtime FETCH_IMAGE_BYTES
//    from the background worker; ported here as an in-page fetch() on
//    the same authenticated Walmart page (same-origin, so the page's own
//    cookies apply — no extension-privileged context needed).

const { SessionExpiredError, fetchLockedOrderNumbers, captureFailure } = require('./lib');
const syncWindow = require('./syncWindow.js');
const { resolveWalmartTracking } = require('./walmartTracking');
const { applyTax } = require('./orderTax');

const { computeSinceDate, WALMART_COLD_START_DAYS, WALMART_MIN_LOOKBACK_DAYS } = syncWindow;

const ORDERS_URL = 'https://www.walmart.com/orders';
const MAX_PAGES = 20;
const MAX_ORDERS = 200;
const DETAIL_FETCH_DELAY_MS = 400;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Detects the logged-out state by URL AND content. Walmart's stale-session
// bounce keeps an orders-style URL (NOT /account/login) but renders a
// captcha/login interstitial, so a URL-only check misses it and sync throws a
// generic error instead of SessionExpiredError — which is why downstream never
// re-queues the site for login. Content signals that appear ONLY on the real
// bounce page: <title>Login | Walmart</title>, a captcha marker (px-captcha /
// "Press & Hold"), or an actual sign-in password form. A genuinely logged-in
// orders page contains benign "Sign in" / "Log in" text and even an
// /account/login href in its header, so we deliberately do NOT grep the HTML
// for those — only the signals below discriminate (same content-check style as
// amazon.js confirmLoggedIn). Async because it reads via page.content() /
// document.title; callers must await.
async function isLoggedOut(page) {
  const url = page.url();
  if (/\/account\/login|\/account\/signin/i.test(url)) return true;

  let html = '';
  try { html = await page.content(); } catch { /* page navigating/closed — fall through */ }

  // Title "Login | Walmart" (from the <title> tag in the full-page HTML).
  if (/<title>\s*Login\s*\|\s*Walmart\s*<\/title>/i.test(html)) return true;
  // Captcha marker: px-captcha element or "Press & Hold to confirm you are a human".
  if (/px-captcha|Press\s*(?:&amp;|&)\s*Hold/i.test(html)) return true;
  // Sign-in password form.
  if (/<input[^>]*type=["']password["']/i.test(html)) return true;

  try {
    const sig = await page.evaluate(walmartSessionSignalsInBrowser);
    if (sig && typeof sig === 'object' && loggedOutFromSignals(sig)) return true;
  } catch { /* ignore */ }

  return false;
}

// Nov 2026: a dead Walmart session on /orders no longer bounces at all. It
// renders the guest "Track your order" page (title "Manage Account - Track
// your order - Walmart.com", header "Sign In / Account" with
// data-testid="sign-in", no purchase history). A signed-in /orders page is
// titled "... Purchase history ..." and its header has no sign-in testid
// (checked live on Penn's signed-in session). Read from the rendered DOM,
// not the HTML string, so benign "Sign in" text elsewhere can't trip it.
function walmartSessionSignalsInBrowser() {
  return {
    title: document.title || '',
    path: location.pathname || '',
    signInButton: !!document.querySelector('[data-testid="sign-in"]'),
  };
}

function loggedOutFromSignals({ title = '', path = '', signInButton = false } = {}) {
  if (/^Login\s*\|\s*Walmart$/i.test(title)) return true;
  if (/^\/orders\b/.test(path) && /Track your order/i.test(title)) return true;
  return signInButton === true;
}

// Ported from scrapeCurrentPage().
function scrapeCurrentPageInBrowser(sinceDateISO) {
  function parseMoney(text) {
    return parseFloat(text.replace(/[^0-9.-]/g, '')) || 0;
  }
  const sinceDateStr = sinceDateISO.slice(0, 10);
  const orders = [];
  let hasOlder = false;
  const seen = new Set();

  const blocks = Array.from(document.querySelectorAll('[data-testid*="orderGroup"], [data-testid*="order-card"], [data-testid*="orderCard"]'));

  const isCancelledOrReturned = text =>
    /(?:\b(?:cancell?ed|cancellation|returned|refunded)\b|we had to cancel|we['’]ve canceled|cancel these items|won['’]t be charged|released the temporary hold)/i.test(text);

  for (const block of blocks) {
    const blockText = (block.textContent ?? '').replace(/\s+/g, ' ');

    let orderNumber = '';
    const captionEl = block.querySelector('[id^="caption-"]');
    if (captionEl) {
      const idMatch = captionEl.id.match(/caption-(\d+)/);
      if (idMatch) orderNumber = idMatch[1];
    }
    if (!orderNumber) {
      const m = blockText.match(/Order\s*#?\s*(\d{10,})/i);
      if (m) orderNumber = m[1];
    }
    if (!orderNumber) {
      const m = blockText.match(/\b(\d{13,20})\b/);
      if (m) orderNumber = m[1];
    }
    if (!orderNumber || seen.has(orderNumber)) continue;
    seen.add(orderNumber);

    const currentYear = new Date().getFullYear();
    let orderDate;
    const dateMatch =
      blockText.match(/(?:Placed|Ordered|Delivered|on)\s+((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4})/i) ??
      blockText.match(/\b((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4})/i) ??
      blockText.match(/(?:Placed|Ordered|Delivered|on)\s+((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2})(?!\d)/i);

    if (dateMatch) {
      let rawDateStr = /\d{4}/.test(dateMatch[1]) ? dateMatch[1] : `${dateMatch[1]} ${currentYear}`;
      orderDate = new Date(rawDateStr);
      const sixtyDaysOut = new Date(); sixtyDaysOut.setDate(sixtyDaysOut.getDate() + 60);
      if (!isNaN(orderDate.getTime()) && orderDate > sixtyDaysOut) {
        rawDateStr = /\d{4}/.test(dateMatch[1]) ? dateMatch[1] : `${dateMatch[1]} ${currentYear - 1}`;
        orderDate = new Date(rawDateStr);
      }
      if (isNaN(orderDate.getTime())) continue;
    } else {
      if (isCancelledOrReturned(blockText)) continue;
      const totalMatch2 = blockText.match(/Total\s+\$?([\d,]+\.?\d*)/i);
      const itemEl2 = block.querySelector('a[href*="/ip/"], [data-testid*="product"], [data-testid*="item"]');
      orders.push({
        platform: 'Walmart',
        orderNumber,
        orderDate: '',
        itemDescription: (itemEl2?.textContent ?? '').trim().slice(0, 120),
        cost: totalMatch2 ? parseMoney(totalMatch2[1]) : 0,
        shippingCost: 0,
        shippingAddress: '',
        trackingNumbers: [],
        sourceUrl: `https://www.walmart.com/orders/${orderNumber}`,
      });
      continue;
    }
    if (orderDate.toISOString().split('T')[0] < sinceDateStr) { hasOlder = true; continue; }
    if (isCancelledOrReturned(blockText)) continue;
    if (/\b(?:Free\s+store\s+pickup|Curbside\s+pickup|Pickup\s+at|Ready\s+for\s+pickup|Store\s+Pickup|Pickup\s+order)\b/i.test(blockText)) continue;

    const totalMatch = blockText.match(/Total\s+\$?([\d,]+\.?\d*)/i);
    const cost = totalMatch ? parseMoney(totalMatch[1]) : 0;

    const productNameEl = block.querySelector('[data-testid="productName"]');
    const fallbackItemEl = block.querySelector('a[href*="/ip/"], [data-testid*="product"], [data-testid*="item"]');
    let itemDescription = (productNameEl?.textContent ?? fallbackItemEl?.textContent ?? '').trim().slice(0, 120);
    if (/^(Walmart\.com|Walmart|Loading|—|—\s*—)$/i.test(itemDescription)) itemDescription = '';

    const last4Match = blockText.match(/(?:ending\s+(?:in)?|\*{2,}|\.{2,})\s*(\d{4})\b/i);
    const paymentLast4 = last4Match?.[1];

    orders.push({
      platform: 'Walmart',
      orderNumber,
      orderDate: orderDate.toISOString().split('T')[0],
      itemDescription,
      cost,
      shippingCost: 0,
      shippingAddress: '',
      trackingNumbers: [],
      sourceUrl: `https://www.walmart.com/orders/${orderNumber}`,
      paymentLast4,
    });
  }

  return { orders, hasOlder, blockCount: blocks.length };
}

// Walmart's order list is a Next.js page. Page 1's orders ship in __NEXT_DATA__
// (props.pageProps.phRedesignInitialData.data.purchaseHistory) and every later
// page arrives as a PurchaseHistoryV3 GraphQL response with the same shape:
// { orders: [{ id, displayId, orderDate, isInStore, groups: [{ status: { statusType },
// fulfillmentType, items: [{ name }] }], priceDetails: { orderTotal: { value } },
// paymentMethods: [{ description: 'Ending in 1234' }] }], pageInfo }.
// Since Nov 2026 the order cards no longer print the placed date (only
// "Arrives by …"), so the date, cancellation and card last 4 come from this
// JSON; the card DOM is the fallback when the JSON is missing.
function readNextDataPurchaseHistoryInBrowser() {
  try {
    const el = document.getElementById('__NEXT_DATA__');
    if (!el) return null;
    const ph = JSON.parse(el.textContent || '{}')?.props?.pageProps?.phRedesignInitialData?.data?.purchaseHistory;
    return ph && Array.isArray(ph.orders) ? { orders: ph.orders, pageInfo: ph.pageInfo ?? null } : null;
  } catch { return null; }
}

// Masked one-line picture of an orders page that produced nothing: no digits,
// so order numbers / prices / card digits never reach the log.
function describeOrdersPageInBrowser() {
  const mask = s => String(s || '').replace(/\d/g, '#').replace(/\s+/g, ' ').trim();
  const ids = Array.from(document.querySelectorAll('[data-testid]')).map(e => e.getAttribute('data-testid'));
  const top = Array.from(new Set(ids.map(mask))).slice(0, 15);
  return {
    title: mask(document.title).slice(0, 80),
    path: mask(location.pathname),
    hasNextData: !!document.getElementById('__NEXT_DATA__'),
    testIds: top,
    captions: document.querySelectorAll('[id^="caption-"]').length,
    text: mask(document.body?.innerText).slice(0, 200),
  };
}

const LAST4_RE = /(?:ending\s+in|ending|\*{2,}|•{2,}|\.{2,})\s*(\d{4})\b/i;

/** PurchaseHistory JSON -> per-order facts. Pure; tolerant of missing fields. */
function walmartOrdersFromPurchaseHistory(ph) {
  const out = [];
  for (const o of Array.isArray(ph?.orders) ? ph.orders : []) {
    if (!o || typeof o !== 'object') continue;
    const orderNumber = String(o.id ?? '').replace(/\D/g, '') || String(o.displayId ?? '').replace(/\D/g, '');
    if (!orderNumber) continue;
    const orderDate = typeof o.orderDate === 'string' && /^\d{4}-\d{2}-\d{2}/.test(o.orderDate) ? o.orderDate.slice(0, 10) : '';
    const groups = Array.isArray(o.groups) ? o.groups.filter(g => g && typeof g === 'object') : [];
    const statuses = groups.map(g => String(g.status?.statusType ?? '').toUpperCase()).filter(Boolean);
    const canceled = statuses.length > 0 && statuses.every(st => /CANCEL|RETURN|REFUND/.test(st));
    const pickup = o.isInStore === true ||
      (groups.length > 0 && groups.every(g => /PICKUP|CURBSIDE|IN_STORE/i.test(String(g.fulfillmentType ?? ''))));
    const item = groups.flatMap(g => (Array.isArray(g.items) ? g.items : []))
      .find(i => typeof i?.name === 'string' && i.name.trim());
    const total = Number(o.priceDetails?.orderTotal?.value);
    const paymentLast4 = (Array.isArray(o.paymentMethods) ? o.paymentMethods : [])
      .map(pm => String(pm?.description ?? '').match(LAST4_RE)?.[1])
      .find(Boolean);
    out.push({
      orderNumber,
      orderDate,
      canceled,
      pickup,
      itemDescription: item ? item.name.trim().slice(0, 120) : '',
      cost: Number.isFinite(total) && total > 0 ? Math.round(total * 100) / 100 : 0,
      paymentLast4,
    });
  }
  return out;
}

/**
 * Combine one list page's JSON facts with its card scrape. JSON wins for date,
 * cancellation, pickup, cost and card last 4; a card the JSON doesn't cover is
 * kept as scraped. hasOlder (stop paging) only when every dated JSON order on
 * the page is before the window: Walmart's list is only roughly newest-first.
 */
function mergeWalmartPage(meta, dom, sinceDateStr) {
  const domOrders = Array.isArray(dom?.orders) ? dom.orders : [];
  if (!Array.isArray(meta) || meta.length === 0) {
    return { orders: domOrders, hasOlder: !!dom?.hasOlder };
  }
  const byNumber = new Map(domOrders.map(o => [o.orderNumber, o]));
  const orders = [];
  const covered = new Set();
  let dated = 0;
  let older = 0;
  for (const m of meta) {
    covered.add(m.orderNumber);
    if (m.orderDate) {
      dated++;
      if (m.orderDate < sinceDateStr) { older++; continue; }
    }
    if (m.canceled || m.pickup) continue;
    const d = byNumber.get(m.orderNumber);
    orders.push({
      platform: 'Walmart',
      orderNumber: m.orderNumber,
      orderDate: m.orderDate || d?.orderDate || '',
      itemDescription: m.itemDescription || d?.itemDescription || '',
      cost: m.cost > 0 ? m.cost : (d?.cost ?? 0),
      shippingCost: 0,
      shippingAddress: '',
      trackingNumbers: [],
      sourceUrl: `https://www.walmart.com/orders/${m.orderNumber}`,
      paymentLast4: m.paymentLast4 || d?.paymentLast4,
    });
  }
  for (const d of domOrders) if (!covered.has(d.orderNumber)) orders.push(d);
  return { orders, hasOlder: dated > 0 ? older === dated : !!dom?.hasOlder };
}

function getFirstBlockFingerprintInBrowser() {
  const block = document.querySelector('[data-testid*="orderGroup"], [data-testid*="order-card"], [data-testid*="orderCard"]');
  if (!block) return '';
  const caption = block.querySelector('[id^="caption-"]');
  if (caption?.id) return caption.id;
  return (block.textContent ?? '').replace(/\s+/g, ' ').slice(0, 80);
}

function ordersLoadedInBrowser() {
  const blocks = document.querySelectorAll('[data-testid*="orderGroup"], [data-testid*="order-card"], [data-testid*="orderCard"]');
  return blocks.length > 0 && (blocks[0].textContent ?? '').length > 100;
}

function clickNextPageInBrowser() {
  const btn = document.querySelector(
    '[aria-label="Next page"]:not([disabled]), [data-automation-id*="next-page"]:not([disabled]), button[aria-label*="next" i]:not([disabled])'
  );
  if (btn) { btn.click(); return true; }
  return false;
}

// Ported from fetchOrderDetail(). Runs against the already-navigated
// detail page's `document` (see module comment for why navigation
// replaces the original's fetch()+DOMParser).
async function extractDetailInBrowser() {
  function parseMoney(text) {
    return parseFloat(text.replace(/[^0-9.-]/g, '')) || 0;
  }
  const html = document.documentElement?.outerHTML ?? '';
  const doc = document;

  let address = '';
  const nextDataEl = doc.querySelector('#__NEXT_DATA__');
  let ndOrder = null;
  if (nextDataEl?.textContent) {
    try {
      const nd = JSON.parse(nextDataEl.textContent);
      ndOrder = nd?.props?.pageProps?.initialData?.data?.order ?? null;
      if (ndOrder) {
        const groupsKey = Object.keys(ndOrder).find(k => k.startsWith('groups_'));
        const firstGroup = groupsKey ? ndOrder[groupsKey]?.[0] : null;
        const addrStr = firstGroup?.deliveryAddress?.address;
        if (addrStr?.addressString) address = String(addrStr.addressString);
      }
    } catch { /* ignore */ }
  }
  if (!address) {
    const addrEl = doc.querySelector('[data-automation-id*="shipping-address"], [class*="shipping-address"], [class*="shippingAddress"]');
    address = (addrEl?.textContent ?? '').replace(/\s+/g, ' ').trim();
  }

  const numbers = new Set();
  for (const pat of [
    /trackingNumber["\s:]+["']?([A-Z0-9]{10,25})/g,
    /\b(1Z[A-Z0-9]{16})\b/g,
    /\b([0-9]{20,22})\b/g,
  ]) {
    let m;
    while ((m = pat.exec(html)) !== null) numbers.add(m[1]);
  }
  const isWalmartInternal = n => /^555\d{15,}$/.test(n);
  const hasInternalTracking = [...numbers].some(isWalmartInternal);
  for (const n of [...numbers]) {
    // Order number stripped below via the caller's orderNumber param
    if (isWalmartInternal(n)) numbers.delete(n);
  }

  // Store-delivery orders (fulfilled by a local store's driver, not a
  // carrier) have no real tracking number — the only tracking-shaped ID
  // on the page is the Walmart-internal 555-prefixed one deleted above.
  // The page positively identifies them with the literal "Delivery from
  // store" text (e.g. id="caption-<orderNumber>-Delivery_from_store"),
  // same text-based fulfillment detection the list scraper uses for
  // pickup orders. The caller falls back to the order number as the
  // tracking value for these, matching app/api/import/route.ts's
  // isOrderNumberTracking convention.
  const isStoreDelivery = /Delivery\s+from\s+store/i.test(html);
  // Terminal delivered state: the standalone word "Delivered" (never the
  // substring in "Delivery"), excluding negations ("Not [yet] delivered") and
  // the caption tail ("-Delivered", which only the caption-id alternative may
  // match). Mirrors DELIVERED_RE in walmartDetailSignals.js.
  const isDelivered = /(?<!\bnot\s+(?:yet\s+)?)(?<!-)\bDelivered\b|caption-\d+-Delivered/i.test(html);

  let orderDate = null;
  let cost = null;
  let taxAmount = null;
  let itemDescription = null;

  const scriptMatches = html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g);
  for (const sm of scriptMatches) {
    const s = sm[1];
    if (!s.includes('orderDate') && !s.includes('placedDate') && !s.includes('totalAmount') && !s.includes('financeTotal')) continue;
    try {
      const parsed = JSON.parse(s);
      const str = JSON.stringify(parsed);
      if (!orderDate) {
        for (const pat of [/"orderDate":"([^"]+)"/, /"placedDate":"([^"]+)"/, /"orderPlacedDate":"([^"]+)"/, /"createdDate":"([^"]+)"/]) {
          const m = str.match(pat); if (m) { orderDate = m[1]; break; }
        }
      }
      if (cost == null) {
        const m = str.match(/"(?:totalAmount|financeTotal|orderTotal|grandTotal|chargeTotal|estimatedTotal|totalCharges|orderTotalAmount|total)"\s*:\s*([\d.]+)/);
        if (m) cost = parseFloat(m[1]);
      }
      if (!itemDescription) {
        const m = str.match(/"(?:productName|itemDescription)"\s*:\s*"([^"]{5,120})"/);
        if (m && !/^(Walmart\.com|Walmart|Loading)$/i.test(m[1])) itemDescription = m[1];
      }
    } catch { /* not JSON */ }
  }

  if (ndOrder) {
    if (cost == null) {
      const gt = ndOrder.priceDetails?.grandTotal;
      if (gt?.value != null) cost = Number(gt.value);
    }
    // Tax from the same priceDetails block as grandTotal. The field name (taxTotal) is the one Walmart's order page data
    // uses as far as known; it has not been checked against a live order, so a missing/renamed field just leaves tax null.
    const pd = ndOrder.priceDetails;
    const taxVal = pd?.taxTotal?.value ?? pd?.tax?.value ?? pd?.estimatedTax?.value;
    if (taxVal != null && Number.isFinite(Number(taxVal))) taxAmount = Number(taxVal);
    if (!itemDescription) {
      const groupsKey = Object.keys(ndOrder).find(k => k.startsWith('groups_'));
      const firstGroup = groupsKey ? ndOrder[groupsKey]?.[0] : null;
      const firstItem = firstGroup?.items?.[0];
      const name = firstItem?.productInfo?.name;
      if (name) itemDescription = name.slice(0, 120);
    }
    if (!orderDate) {
      const str = JSON.stringify(ndOrder);
      for (const pat of [/"orderDate":"([^"]+)"/, /"placedDate":"([^"]+)"/, /"orderPlacedDate":"([^"]+)"/, /"createdDate":"([^"]+)"/]) {
        const m = str.match(pat); if (m) { orderDate = m[1]; break; }
      }
    }
  }
  if (cost == null) {
    const m = html.match(/(?:order\s+)?total[^$\d]{0,30}\$\s*([\d,]+\.?\d*)/i);
    if (m) cost = parseMoney(m[1]);
  }
  if (!orderDate) {
    const m = html.match(/[Pp]laced[^<]{0,80}?(\d{4}-\d{2}-\d{2})/);
    if (m) orderDate = m[1];
  }
  if (cost == null) {
    const totalEl = doc.querySelector('[data-automation-id*="order-total"], [class*="orderTotal"], [class*="order-total"]');
    if (totalEl) cost = parseMoney(totalEl.textContent ?? '');
  }
  if (!itemDescription) {
    const itemEl = doc.querySelector('[data-automation-id*="product-title"], [class*="product-title"], h2[class*="item"]');
    if (itemEl) itemDescription = (itemEl.textContent ?? '').trim().slice(0, 120) || null;
  }
  if (itemDescription && /^(Walmart\.com|Walmart|Loading|—|—\s*—)$/i.test(itemDescription.trim())) itemDescription = null;

  let paymentLast4;
  for (const pat of [
    /"lastFour"\s*:\s*"?(\d{4})"?/, /"lastFourDigits"\s*:\s*"?(\d{4})"?/,
    /"cardLast4"\s*:\s*"?(\d{4})"?/, /"last4"\s*:\s*"?(\d{4})"?/,
    /"cardNumberLast4"\s*:\s*"?(\d{4})"?/, /"accountNumberLast4"\s*:\s*"?(\d{4})"?/,
  ]) {
    const m = html.match(pat);
    if (m) { paymentLast4 = m[1]; break; }
  }
  if (!paymentLast4) {
    for (const pat of [
      /\bending\s+in\s+(\d{4})\b/i, /\bending\s+(\d{4})\b/i,
      /\*{2,}\s*(\d{4})\b/, /\bx{4,}\s*(\d{4})\b/i, /[•·․⋅●]{2,}\s*(\d{4})\b/,
      /(?:&bull;|&middot;|&#x2022;|&#8226;){2,}\s*(\d{4})\b/i,
    ]) {
      const m = html.match(pat);
      if (m) { paymentLast4 = m[1]; break; }
    }
  }

  // Delivery photo: in-page fetch so the browser's own Walmart cookies apply.
  let deliveryPhotoUrl, deliveryPhotoBase64, deliveryPhotoMime;
  const photoImg = doc.querySelector('img[alt="Proof of delivery location"], img[src*="/delivery-photo/"]');
  const photoSrc = photoImg?.getAttribute('src') || '';
  if (photoSrc && /^https?:\/\//i.test(photoSrc)) {
    deliveryPhotoUrl = photoSrc;
    try {
      const r = await fetch(photoSrc, { credentials: 'include' });
      if (r.ok) {
        const buf = await r.arrayBuffer();
        let binary = '';
        const bytes = new Uint8Array(buf);
        for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
        deliveryPhotoBase64 = btoa(binary);
        deliveryPhotoMime = r.headers.get('content-type') || 'image/jpeg';
      }
    } catch { /* ignore — server can still try the URL directly */ }
  }

  return {
    address, tracking: [...numbers], isStoreDelivery, isDelivered, orderDate, cost, taxAmount, itemDescription, hasInternalTracking,
    paymentLast4, deliveryPhotoUrl, deliveryPhotoBase64, deliveryPhotoMime,
  };
}

// Secondary hardening: a session-expiry bounce that lands *during* a
// page.evaluate throws "Execution context was destroyed" (or similar) instead
// of being detected cleanly. Re-check isLoggedOut on failure and convert to
// SessionExpiredError so poll.js flips walmart_session_status='expired' and
// re-queues login, rather than labeling the capture sync-failed with a generic
// error. Non-session errors are rethrown unchanged.
async function evaluateOrSessionExpired(page, fn, ...args) {
  try {
    return await page.evaluate(fn, ...args);
  } catch (e) {
    if (await isLoggedOut(page)) throw new SessionExpiredError('walmart');
    throw e;
  }
}

async function waitForOrdersToLoad(page, previousFingerprint, timeoutMs = 12000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await page.evaluate(ordersLoadedInBrowser)) {
      const fp = await page.evaluate(getFirstBlockFingerprintInBrowser);
      if (!previousFingerprint || fp !== previousFingerprint) return;
    }
    await sleep(400);
  }
}

// Ported from startSync()/runSync(). walmartLastSync overlap logic unchanged.
function computeWalmartSinceDate(lastSyncIso, now = new Date()) {
  return computeSinceDate({
    lastSyncIso,
    coldStartDays: WALMART_COLD_START_DAYS,
    minLookbackDays: WALMART_MIN_LOOKBACK_DAYS,
    overlapMs: 48 * 60 * 60 * 1000,
    now
  });
}

async function syncWalmart(page, { lastSyncIso }) {
  const sinceDate = computeWalmartSinceDate(lastSyncIso);
  const sinceDateISO = sinceDate.toISOString();
  const sinceDateStr = sinceDateISO.slice(0, 10);
  console.log(`[walmart] syncing since ${sinceDateStr}`);

  // Pages 2+ load their orders over GraphQL; keep each PurchaseHistory body.
  const captured = [];
  const onResponse = async resp => {
    try {
      if (!/\/graphql\/PurchaseHistory/i.test(resp.url())) return;
      const ph = (await resp.json())?.data?.purchaseHistory;
      if (ph && Array.isArray(ph.orders)) captured.push(ph);
    } catch { /* not JSON, or the body is gone */ }
  };
  const canListen = typeof page.on === 'function';
  if (canListen) page.on('response', onResponse);

  const allOrders = [];
  try {
    await page.goto(ORDERS_URL, { waitUntil: 'domcontentloaded' });
    if (await isLoggedOut(page)) throw new SessionExpiredError('walmart');
    await waitForOrdersToLoad(page, '');

    const seen = new Set();
    let pageNum = 1;
    let capturedBefore = 0;

    while (pageNum <= MAX_PAGES && allOrders.length < MAX_ORDERS) {
      let json = null;
      if (pageNum === 1) {
        json = (await page.evaluate(readNextDataPurchaseHistoryInBrowser).catch(() => null)) || null;
        if (!json && captured.length) json = captured[captured.length - 1];
      } else if (captured.length > capturedBefore) {
        json = captured[captured.length - 1];
      }
      const meta = json ? walmartOrdersFromPurchaseHistory(json) : [];
      const dom = await evaluateOrSessionExpired(page, scrapeCurrentPageInBrowser, sinceDateISO);

      if (pageNum === 1 && !json && !dom?.blockCount && !(dom?.orders?.length)) {
        if (await isLoggedOut(page)) throw new SessionExpiredError('walmart');
        const why = await page.evaluate(describeOrdersPageInBrowser).catch(e => ({ error: e.message }));
        console.warn('[walmart] orders page has no order cards and no order data:', JSON.stringify(why));
        if (typeof captureFailure === 'function') await captureFailure(page, 'walmart', 'no-orders').catch(() => {});
        throw new Error('Walmart orders page loaded with no orders or order data (saved a debug capture)');
      }

      const { orders, hasOlder } = mergeWalmartPage(meta, dom, sinceDateStr);
      for (const o of orders) {
        if (!seen.has(o.orderNumber)) { seen.add(o.orderNumber); allOrders.push(o); }
      }
      console.log(`[walmart] page ${pageNum} scraped ${orders.length} (json ${meta.length}, cards ${dom?.blockCount ?? '?'}), total=${allOrders.length}, hasOlder=${hasOlder}`);
      if (hasOlder) break;

      const fingerprint = await page.evaluate(getFirstBlockFingerprintInBrowser);
      capturedBefore = captured.length;
      const clicked = await page.evaluate(clickNextPageInBrowser);
      if (!clicked) break;
      await waitForOrdersToLoad(page, fingerprint);
      for (let i = 0; i < 25 && captured.length <= capturedBefore; i++) await sleep(200);
      pageNum++;
    }
  } finally {
    if (canListen && typeof page.off === 'function') page.off('response', onResponse);
  }

  const locked = await fetchLockedOrderNumbers('walmart');
  let orders = allOrders;
  if (locked.size > 0) {
    const before = orders.length;
    orders = orders.filter(o => !locked.has(o.orderNumber));
    console.log(`[walmart] skipping ${before - orders.length} locked order(s); ${orders.length} remain`);
  }

  for (const order of orders) {
    console.log(`[walmart] detail: ${order.orderNumber}`);
    await sleep(DETAIL_FETCH_DELAY_MS);
    await page.goto(order.sourceUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
    if (await isLoggedOut(page)) throw new SessionExpiredError('walmart');
    const detail = await evaluateOrSessionExpired(page, extractDetailInBrowser);
    if (detail.address) order.shippingAddress = detail.address;
    const filteredTracking = detail.tracking.filter(t => t !== order.orderNumber);
    order.trackingNumbers = resolveWalmartTracking({
      orderNumber: order.orderNumber,
      scrapedTracking: filteredTracking,
      isStoreDelivery: detail.isStoreDelivery,
      isDelivered: detail.isDelivered,
      hasInternalTracking: detail.hasInternalTracking,
    }).trackingNumbers ?? [];
    if (detail.cost != null && detail.cost > 0 && order.cost === 0) order.cost = detail.cost;
    applyTax(order, detail.taxAmount);
    if (detail.itemDescription && !order.itemDescription) order.itemDescription = detail.itemDescription;
    if (detail.paymentLast4 && !order.paymentLast4) order.paymentLast4 = detail.paymentLast4;
    if (detail.deliveryPhotoUrl) order.deliveryPhotoUrl = detail.deliveryPhotoUrl;
    if (detail.deliveryPhotoBase64) order.deliveryPhotoBase64 = detail.deliveryPhotoBase64;
    if (detail.deliveryPhotoMime) order.deliveryPhotoMime = detail.deliveryPhotoMime;
    if (detail.orderDate) order.orderDate = detail.orderDate;
    else if (!order.orderDate) order.orderDate = new Date().toISOString().split('T')[0];
  }

  const todayStr = sinceDateISO.slice(0, 10);
  return orders.filter(o => o.orderDate >= todayStr);
}

module.exports = { syncWalmart, isLoggedOut, loggedOutFromSignals, ORDERS_URL, computeWalmartSinceDate, walmartOrdersFromPurchaseHistory, mergeWalmartPage };
