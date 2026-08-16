'use strict';

// Ported from resell-tracker-extension/src/content/amazon.ts. This is a
// port, not a rewrite — the DOM-parsing functions below are copied
// near-verbatim from that file and run in the *page* context via
// page.evaluate() (same DOM/regex code, same edge cases already solved
// there: promo-card / store-pickup / Amazon-Business-order-113 filtering,
// split-shipment tracking, No-Rush bonus capture, etc).
//
// What's genuinely different from the extension, and why:
//  - The extension used two different HTML-acquisition strategies
//    (live-DOM navigation for the current year because Amazon SPA-renders
//    it; background fetch() + DOMParser for past years because Amazon
//    SSRs those) plus a sessionStorage/chrome.storage.local resume-state
//    dance to survive the content-script instance getting torn down and
//    recreated on every `window.location.href` navigation. None of that
//    is needed here: this script owns the whole browser and drives one
//    continuous async function across every navigation, so it just
//    page.goto()s every page/detail/tracking URL directly and keeps
//    state in local variables. Verified against the same Amazon
//    rendering quirks the original comments describe — direct
//    navigation gets the same rendered DOM either way.
//  - chrome.runtime messaging (progress/badge/log-forwarding) is gone;
//    replaced by plain console.log, which the poll loop forwards to
//    Docker logs.

const { SessionExpiredError, fetchLockedOrderNumbers } = require('./lib');

const ORDERS_URL = 'https://www.amazon.com/your-orders/orders';
const MAX_ORDERS = 500;
const MAX_TRACKING_PAGES = 8;
const DETAIL_FETCH_DELAY_MS = 800;
const TRACKING_FETCH_DELAY_MS = 600;

// ---------------------------------------------------------------------------
// In-page functions (executed via page.evaluate — `document`/`window` refer
// to the live Amazon page, not Node). Ported from amazon.ts scrapeDoc().
// ---------------------------------------------------------------------------

function scrapeDocInBrowser(sinceDateISO) {
  function parseMoney(text) {
    return parseFloat(text.replace(/[^0-9.-]/g, '')) || 0;
  }
  const sinceDateStr = sinceDateISO.slice(0, 10);
  const orders = [];
  let hasOlder = false;
  const seen = new Set();

  const orderLinks = Array.from(document.querySelectorAll(
    'a[href*="orderID="], a[href*="orderId="], a[href*="order-details"]'
  ));

  for (const link of orderLinks) {
    const idMatch = link.href.match(/[oO]rder[Ii][Dd]=([0-9A-Z-]{10,})/);
    if (!idMatch) continue;
    const orderId = idMatch[1];
    if (seen.has(orderId)) continue;
    seen.add(orderId);

    let card = link;
    for (let i = 0; i < 20; i++) {
      card = card?.parentElement ?? null;
      if (!card) break;
      const t = (card.textContent ?? '').replace(/\s+/g, ' ');
      if (t.length > 100 && /(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|January|February|March|April|June|July|August|September|October|November|December)/i.test(t)) break;
    }
    if (!card) continue;
    const rawText = ('innerText' in card) ? card.innerText : (card.textContent ?? '');
    const cardText = rawText.replace(/\s+/g, ' ');

    const dateMatch = cardText.match(/Order placed\s+((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4})/i)
      ?? cardText.match(/((?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4})/i)
      ?? cardText.match(/((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\.?\s+\d{1,2},?\s+\d{4})/i);
    if (!dateMatch) continue;

    const orderDate = new Date(dateMatch[1]);
    if (isNaN(orderDate.getTime())) continue;
    if (orderDate.toISOString().split('T')[0] < sinceDateStr) { hasOlder = true; continue; }

    if (/\b(cancelled|canceled|refunded|returned)\b/i.test(cardText)) continue;

    const totalMatch = cardText.match(/Total\s+\$?([\d,]+\.?\d*)/i);
    const cost = totalMatch ? parseMoney(totalMatch[1]) : 0;

    let paymentLast4;
    for (const pat of [
      /\bending\s+in\s+(\d{4})\b/i,
      /\bending\s+(\d{4})\b/i,
      /\*{2,}\s*(\d{4})\b/,
      /\bx{4,}\s*(\d{4})\b/i,
      /[•·․⋅●]{2,}\s*(\d{4})\b/,
    ]) {
      const m = cardText.match(pat);
      if (m) { paymentLast4 = m[1]; break; }
    }

    const hasApplyNow = /\bApply\s+now\b/i.test(cardText);
    const promoPhrase = /\b(?:Earn\s+(?:up\s+to\s+)?\d+%|Get\s+the\s+Amazon\s+(?:Business\s+)?(?:Prime\s+)?Visa|Get\s+a\s+\$?\d+\s+Amazon\.com\s+(?:Gift\s+Card|Credit)|No\s+annual\s+fee|Card\s+Member)\b/i.test(cardText);
    if (hasApplyNow || (cost === 0 && promoPhrase)) continue;

    const pickupPhrase = /\b(?:Ready\s+for\s+pickup|Pick\s+up\s+at|Amazon\s+Locker|Fresh\s+Pickup|Store\s+Pickup|Whole\s+Foods\s+Market\b)\b/i;
    if (pickupPhrase.test(cardText)) continue;

    let shippingAddress = '';
    const addrMatch = cardText.match(/Ship to\s+(.+?)\s+United States/is);
    if (addrMatch) {
      const full = addrMatch[1].replace(/\s+/g, ' ').trim();
      const digitIdx = full.search(/\d/);
      shippingAddress = digitIdx > 0 ? full.slice(digitIdx) : full;
    }

    const titleEl = card.querySelector(
      '[class*="product-title"],[class*="item-title"],[class*="yohtmlc-item"],[class*="a-link-normal"][href*="/dp/"],[data-component*="item"] a,a[href*="/dp/"],a[href*="/gp/product/"]'
    );
    let itemDescription = (titleEl?.textContent ?? '').trim().slice(0, 120);
    if (!itemDescription) {
      const productLink = card.querySelector('a[href*="/dp/"], a[href*="/gp/product/"]');
      itemDescription = (productLink?.textContent ?? '').trim().slice(0, 120);
    }

    const trackButtons = Array.from(card.querySelectorAll('a[href*="ship-track"], a[href*="progress-tracker"], a[href*="package-tracking"]'))
      .map(a => a.href)
      .filter(h => !/\/(preship|cancel-items?|return|refund|replacement)\b/i.test(h))
      .filter((href, i, arr) => arr.indexOf(href) === i);

    orders.push({
      platform: 'Amazon',
      orderNumber: orderId,
      orderDate: orderDate.toISOString().split('T')[0],
      itemDescription,
      cost,
      shippingCost: 0,
      shippingAddress,
      trackingNumbers: [],
      sourceUrl: `https://www.amazon.com/gp/your-account/order-details?orderID=${orderId}`,
      paymentLast4,
      _listTrackingUrls: trackButtons,
    });
  }

  return { orders, hasOlder };
}

function getNextStartIndexInBrowser() {
  const strictEl = document.querySelector('.a-pagination .a-last:not(.a-disabled) a, [aria-label="Next page"] a');
  if (strictEl?.href) {
    const m = strictEl.href.match(/startIndex=(\d+)/);
    if (m) return parseInt(m[1]);
  }
  const candidates = Array.from(document.querySelectorAll('a[href*="startIndex="]'));
  for (const a of candidates) {
    const text = (a.textContent ?? '').trim();
    if (/^Next\b/i.test(text) || text.includes('→')) {
      const m = a.href.match(/startIndex=(\d+)/);
      if (m) return parseInt(m[1]);
    }
  }
  let best = 0;
  for (const a of candidates) {
    const m = (a.getAttribute('href') ?? '').match(/startIndex=(\d+)/);
    if (m) { const v = parseInt(m[1]); if (v > best) best = v; }
  }
  return best > 0 ? best : null;
}

function waitForOrdersInBrowser() {
  return document.querySelectorAll('a[href*="orderID="], a[href*="orderId="], a[href*="order-details"]').length > 0;
}

// Ported from extractCarrierTracking/extractTitleFromDoc/extractAddressFromDoc/
// extractCostFromDoc/extractOrderDateFromDoc + the not-found detection in
// fetchOrderDetails(). Runs against the detail page's own `document`.
function extractDetailInBrowser() {
  function parseMoney(text) {
    return parseFloat(text.replace(/[^0-9.-]/g, '')) || 0;
  }
  function extractCarrierTracking(doc) {
    const found = [];
    const text = (doc.body?.textContent ?? '').replace(/\s+/g, ' ');
    const ptCards = Array.from(doc.querySelectorAll('.pt-delivery-card-trackingId, [class*="trackingId"]'));
    for (const el of ptCards) {
      const v = (el.textContent ?? '').replace(/Tracking\s*(?:ID|number)?[:\s]*/i, '').trim().split(/\s+/)[0];
      if (v && /^[A-Z0-9]{8,30}$/i.test(v)) found.unshift(v);
    }
    const amzl = text.match(/\bTBA(\d{12,15})(?!\d)/g)?.map(m => m.replace(/\D+$/, ''));
    const ups = text.match(/\b(1Z[A-Z0-9]{16})\b/g);
    const usps = text.match(/\b(9[0-9]{19,21})\b/g);
    const fedex = text.match(/\b([1-8][0-9]{14})\b/g);
    const nearLabel = text.match(/Tracking(?:\s+ID|\s+number)?[:\s]+([A-Z0-9]{10,30})/gi) ?? [];
    for (const m of nearLabel) {
      const val = m.replace(/Tracking(?:\s+ID|\s+number)?[:\s]+/i, '').trim().split(' ')[0];
      if (val) found.unshift(val);
    }
    if (amzl) found.push(...amzl);
    if (ups) found.push(...ups);
    if (usps) found.push(...usps);
    if (fedex) found.push(...fedex);
    const carrierLinks = Array.from(doc.querySelectorAll('a[href]'))
      .map(a => a.href)
      .filter(h => /usps\.com|ups\.com|fedex\.com|dhl\.com|ontrac\.com|lasership\.com/i.test(h));
    for (const href of carrierLinks) {
      const m = href.match(/[?&](?:qtc_tLabels1|tLabels|tracknum|InquiryNumber\d*|tracknumbers|trknbr|AWB|tracking[_-]?number[s]?|trackingNumber)=([A-Z0-9]{8,30})/i);
      if (m) found.unshift(m[1]);
    }
    return [...new Set(found)];
  }

  const detailDocHtml = document.documentElement?.outerHTML ?? '';
  const looksLikeNotFound =
    /We can't find an order with that number|Looking for an order|Page Not Found/i.test(detailDocHtml) ||
    !/order-details|order-summary|orderDetails|pmts-payments/i.test(detailDocHtml);
  if (looksLikeNotFound) return { notFound: true };

  let title = '';
  for (const el of [
    document.querySelector('[data-component="itemTitle"] a'),
    document.querySelector('.yohtmlc-item a.a-link-normal'),
    document.querySelector('.a-link-normal[href*="/dp/"]'),
    document.querySelector('.a-link-normal[href*="/gp/product/"]'),
  ]) {
    const text = (el?.textContent ?? '').trim().replace(/\s+/g, ' ');
    if (text.length > 5) { title = text.slice(0, 120); break; }
  }
  if (!title) {
    for (const a of Array.from(document.querySelectorAll('a[href]'))) {
      if (!/\/dp\/[A-Z0-9]{10}|\/gp\/product\/[A-Z0-9]{10}/.test(a.href)) continue;
      const text = (a.textContent ?? '').trim().replace(/\s+/g, ' ');
      if (text.length > 5) { title = text.slice(0, 120); break; }
    }
  }

  let address = '';
  for (const h of Array.from(document.querySelectorAll('h5'))) {
    if (!/ship\s+to/i.test(h.textContent ?? '')) continue;
    const ul = h.nextElementSibling;
    if (!ul || ul.tagName !== 'UL') continue;
    const items = Array.from(ul.querySelectorAll('li span.a-list-item'))
      .map(el => (el.innerHTML ?? '').replace(/<br\s*\/?>/gi, ', ').replace(/<[^>]+>/g, '').trim().replace(/\s+/g, ' '))
      .filter(t => t && !/^united states$/i.test(t));
    const addrItems = items.slice(1);
    if (addrItems.length > 0) { address = addrItems.join(', ').slice(0, 200); break; }
  }

  const bodyText = (document.body?.textContent ?? '').replace(/\s+/g, ' ');
  let cost = 0;
  const totalMatch = bodyText.match(/(?:Order Total|Grand Total)[:\s]+\$?([\d,]+\.?\d*)/i)
    ?? bodyText.match(/\bTotal[:\s]+\$?([\d,]+\.?\d*)/i);
  if (totalMatch) cost = parseMoney(totalMatch[1]);

  // orderDate candidates (JSON-ish + data attrs + visible text)
  let orderDate = null;
  const candidates = [];
  for (const pat of [
    /"orderDate"\s*:\s*"([^"]+)"/i, /"orderPlacedDate"\s*:\s*"([^"]+)"/i,
    /"placedDate"\s*:\s*"([^"]+)"/i, /"orderTimestamp"\s*:\s*"?([^",}]+)"?/i,
    /"creationDate"\s*:\s*"([^"]+)"/i,
  ]) {
    const m = detailDocHtml.match(pat);
    if (m) candidates.push(m[1]);
  }
  document.querySelectorAll('[data-order-date], [data-order-placed-date], [data-order-timestamp]').forEach(el => {
    for (const attr of ['data-order-date', 'data-order-placed-date', 'data-order-timestamp']) {
      const v = el.getAttribute(attr);
      if (v) candidates.push(v);
    }
  });
  const textMatch = detailDocHtml.match(/Order placed[:\s]+((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}(?:\s+\d{1,2}:\d{2}(?:\s?[AP]M)?)?)/i);
  if (textMatch) candidates.push(textMatch[1]);
  for (const c of candidates) {
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(c)) { orderDate = c; break; }
  }
  if (!orderDate && candidates.length > 0) {
    const parsed = new Date(candidates[0]);
    orderDate = isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }

  let noRushBonusPercent;
  const noRushMatch = detailDocHtml.match(/(?:extra|additional)\s+(\d+(?:\.\d+)?)\s*%[^<]{0,80}No[- ]?Rush/i);
  if (noRushMatch) noRushBonusPercent = parseFloat(noRushMatch[1]);

  // Scope to the actual charged-payment-method box first — the whole page
  // can contain other "ending in ####" text (gift card balance, promo card
  // upsells, split-payment lines) earlier in the DOM than the real charge,
  // which used to win the first-match-wins search below.
  const paymentBox = document.querySelector('[class*="paystationpaymentmethod"]');
  const paymentSearchText = ((paymentBox ?? document.documentElement)?.outerHTML) ?? detailDocHtml;

  let paymentLast4;
  for (const pat of [
    /\bending\s+in\s+(\d{4})\b/i, /\bending\s+(\d{4})\b/i,
    /\*{2,}\s*(\d{4})\b/, /\bx{4,}\s*(\d{4})\b/i, /[•·․⋅●]{2,}\s*(\d{4})\b/,
  ]) {
    const m = paymentSearchText.match(pat);
    if (m) { paymentLast4 = m[1]; break; }
  }

  const detailPageUrls = Array.from(document.querySelectorAll('a[href*="ship-track"], a[href*="progress-tracker"], a[href*="package-tracking"]'))
    .map(a => a.href)
    .filter(h => !/\/(preship|cancel-items?|return|refund|replacement)\b/i.test(h));

  const fromDetail = extractCarrierTracking(document);

  return { notFound: false, title, address, cost, orderDate, noRushBonusPercent, paymentLast4, detailPageUrls, fromDetail };
}

function extractTrackingPageInBrowser() {
  function extractCarrierTracking(doc) {
    const found = [];
    const text = (doc.body?.textContent ?? '').replace(/\s+/g, ' ');
    const ptCards = Array.from(doc.querySelectorAll('.pt-delivery-card-trackingId, [class*="trackingId"]'));
    for (const el of ptCards) {
      const v = (el.textContent ?? '').replace(/Tracking\s*(?:ID|number)?[:\s]*/i, '').trim().split(/\s+/)[0];
      if (v && /^[A-Z0-9]{8,30}$/i.test(v)) found.unshift(v);
    }
    const amzl = text.match(/\bTBA(\d{12,15})(?!\d)/g)?.map(m => m.replace(/\D+$/, ''));
    const ups = text.match(/\b(1Z[A-Z0-9]{16})\b/g);
    const usps = text.match(/\b(9[0-9]{19,21})\b/g);
    const fedex = text.match(/\b([1-8][0-9]{14})\b/g);
    const nearLabel = text.match(/Tracking(?:\s+ID|\s+number)?[:\s]+([A-Z0-9]{10,30})/gi) ?? [];
    for (const m of nearLabel) {
      const val = m.replace(/Tracking(?:\s+ID|\s+number)?[:\s]+/i, '').trim().split(' ')[0];
      if (val) found.unshift(val);
    }
    if (amzl) found.push(...amzl);
    if (ups) found.push(...ups);
    if (usps) found.push(...usps);
    if (fedex) found.push(...fedex);
    const carrierLinks = Array.from(doc.querySelectorAll('a[href]'))
      .map(a => a.href)
      .filter(h => /usps\.com|ups\.com|fedex\.com|dhl\.com|ontrac\.com|lasership\.com/i.test(h));
    for (const href of carrierLinks) {
      const m = href.match(/[?&](?:qtc_tLabels1|tLabels|tracknum|InquiryNumber\d*|tracknumbers|trknbr|AWB|tracking[_-]?number[s]?|trackingNumber)=([A-Z0-9]{8,30})/i);
      if (m) found.unshift(m[1]);
    }
    return [...new Set(found)];
  }
  document.querySelectorAll('nav, footer, #navbar, #navFooter, #rhf').forEach(el => el.remove());
  const tracking = extractCarrierTracking(document);
  const photoImg = document.querySelector('img.photo-on-delivery-img-thumb, img[class*="photo-on-delivery"]');
  const candidate = photoImg?.getAttribute('data-src') || photoImg?.getAttribute('src') || '';
  const deliveryPhotoUrl = /^https?:\/\//i.test(candidate) ? candidate : undefined;
  return { tracking, deliveryPhotoUrl };
}

// ---------------------------------------------------------------------------
// Node-side orchestration
// ---------------------------------------------------------------------------

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitForOrders(page, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await page.evaluate(waitForOrdersInBrowser)) return;
    await sleep(500);
  }
}

function isLoggedOut(page) {
  const url = page.url();
  return /\/ap\/signin|\/ap\/cvf/i.test(url);
}

async function scrapeYear(page, year, sinceDateISO, allOrders, seen) {
  let pageUrl = year != null ? `${ORDERS_URL}?timeFilter=year-${year}` : ORDERS_URL;
  while (allOrders.length < MAX_ORDERS) {
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded' });
    await waitForOrders(page);
    await sleep(1500);
    if (isLoggedOut(page)) throw new SessionExpiredError('amazon');

    const { orders, hasOlder } = await page.evaluate(scrapeDocInBrowser, sinceDateISO);
    for (const o of orders) {
      if (!seen.has(o.orderNumber)) { seen.add(o.orderNumber); allOrders.push(o); }
    }
    console.log(`[amazon] year=${year ?? 'current'} page scraped ${orders.length} orders, hasOlder=${hasOlder}, total=${allOrders.length}`);
    if (hasOlder) return true; // hit sinceDate — caller stops walking further back

    const nextIndex = await page.evaluate(getNextStartIndexInBrowser);
    if (nextIndex == null) return false; // no more pages, didn't hit sinceDate
    pageUrl = year != null
      ? `${ORDERS_URL}?startIndex=${nextIndex}&timeFilter=year-${year}`
      : `${ORDERS_URL}?startIndex=${nextIndex}`;
    await sleep(400);
  }
  return false;
}

async function fetchOrderDetails(page, orderId, extraTrackingUrls) {
  await page.goto(`https://www.amazon.com/gp/your-account/order-details?orderID=${orderId}`, { waitUntil: 'domcontentloaded' });
  if (isLoggedOut(page)) throw new SessionExpiredError('amazon');
  const detail = await page.evaluate(extractDetailInBrowser);
  if (detail.notFound) return { notFound: true };

  const trackingPageUrls = [...(detail.detailPageUrls || []), ...(extraTrackingUrls || [])]
    .filter((href, i, arr) => arr.indexOf(href) === i);

  const tracking = [...(detail.fromDetail || [])];
  let deliveryPhotoUrl;
  for (const url of trackingPageUrls.slice(0, MAX_TRACKING_PAGES)) {
    await sleep(TRACKING_FETCH_DELAY_MS);
    await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
    const { tracking: fromPage, deliveryPhotoUrl: photo } = await page.evaluate(extractTrackingPageInBrowser).catch(() => ({ tracking: [], deliveryPhotoUrl: undefined }));
    tracking.push(...fromPage);
    if (!deliveryPhotoUrl && photo) deliveryPhotoUrl = photo;
  }

  const cleaned = [...new Set(tracking)].map(t => /^1Z/i.test(t) ? t : t.replace(/[A-Za-z]+$/, ''));
  const cleanedNonEmpty = [...new Set(cleaned)].filter(t => t && t.length >= 8);
  const unique = cleanedNonEmpty.filter(t => !cleanedNonEmpty.some(other => other !== t && t.startsWith(other))).slice(0, 5);

  return {
    notFound: false,
    tracking: unique,
    title: detail.title,
    address: detail.address,
    cost: detail.cost,
    orderDate: detail.orderDate,
    paymentLast4: detail.paymentLast4,
    noRushBonusPercent: detail.noRushBonusPercent,
    deliveryPhotoUrl,
  };
}

// Runs a full Amazon sync against an already-authenticated `page` (context
// loaded from the amazon-session.json storageState). Ported from
// amazon.ts's startSync()/runSync(); the 60-day-floor / lastSync overlap
// logic is unchanged.
function computeAmazonSinceDate(lastSyncIso, now = new Date()) {
  const sixtyDaysAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);
  const lastSyncDate = lastSyncIso ? new Date(lastSyncIso) : null;
  return !lastSyncDate
    ? sixtyDaysAgo
    : lastSyncDate < sixtyDaysAgo
      ? lastSyncDate
      : new Date(lastSyncDate.getTime() - 24 * 60 * 60 * 1000);
}

async function syncAmazon(page, { lastSyncIso }) {
  const sinceDate = computeAmazonSinceDate(lastSyncIso);
  const sinceDateISO = sinceDate.toISOString();

  const fromYear = sinceDate.getFullYear();
  const toYear = new Date().getFullYear();

  const allOrders = [];
  const seen = new Set();

  console.log(`[amazon] syncing since ${sinceDateISO.slice(0, 10)} (years ${fromYear}-${toYear})`);

  let hasOlderHit = false;
  if (toYear >= fromYear) {
    hasOlderHit = await scrapeYear(page, toYear, sinceDateISO, allOrders, seen);
  }
  if (!hasOlderHit) {
    for (let year = toYear - 1; year >= fromYear && allOrders.length < MAX_ORDERS; year--) {
      const hit = await scrapeYear(page, year, sinceDateISO, allOrders, seen);
      if (hit) break;
    }
  }

  // Skip locked orders (server rejects writes anyway — matches extension).
  const locked = await fetchLockedOrderNumbers('amazon');
  let orders = allOrders;
  if (locked.size > 0) {
    const before = orders.length;
    orders = orders.filter(o => !locked.has(o.orderNumber));
    console.log(`[amazon] skipping ${before - orders.length} locked order(s); ${orders.length} remain`);
  }

  for (let i = 0; i < orders.length; i++) {
    const order = orders[i];
    console.log(`[amazon] detail ${i + 1}/${orders.length}: ${order.orderNumber}`);
    await sleep(DETAIL_FETCH_DELAY_MS);
    const detail = await fetchOrderDetails(page, order.orderNumber, order._listTrackingUrls);
    if (detail.notFound) { order._skipBusiness = true; continue; }
    if (detail.tracking.length > 0) order.trackingNumbers = detail.tracking;
    if (!order.itemDescription && detail.title) order.itemDescription = detail.title;
    if (!order.shippingAddress && detail.address) order.shippingAddress = detail.address;
    if (!order.cost && detail.cost) order.cost = detail.cost;
    if (detail.deliveryPhotoUrl) order.deliveryPhotoUrl = detail.deliveryPhotoUrl;
    if (!order.paymentLast4 && detail.paymentLast4) order.paymentLast4 = detail.paymentLast4;
    if (detail.noRushBonusPercent != null) order.noRushBonusPercent = detail.noRushBonusPercent;
    if (detail.orderDate && /T\d{2}:\d{2}/.test(detail.orderDate)) order.orderDate = detail.orderDate;
  }

  const filtered = orders.filter(o => !o._skipBusiness);
  for (const o of filtered) { delete o._listTrackingUrls; delete o._skipBusiness; }
  return filtered;
}

module.exports = { syncAmazon, isLoggedOut, ORDERS_URL, computeAmazonSinceDate };
