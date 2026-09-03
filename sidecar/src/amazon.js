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

const { SessionExpiredError } = require('./lib');
const { computeAmazonSinceDate } = require('./syncWindow');

const ORDERS_URL = 'https://www.amazon.com/your-orders/orders';
const MAX_ORDERS = 500;
const MAX_TRACKING_PAGES = 8;
const DETAIL_FETCH_DELAY_MS = 800;
const TRACKING_FETCH_DELAY_MS = 600;

// Safety cap for scrapeYear's pagination walk (see the comment on that
// function): stop only after this many CONSECUTIVE pages in a row have
// contributed zero in-window orders. Amazon's order-history page is not
// strictly newest-to-oldest -- subscription renewals, multi-item orders,
// and reorders can interleave an old-dated card next to a newer one, both
// within a page and across a page boundary -- so a single old page is not
// reliable evidence that every later page is also old. Amazon's default
// page size is ~10 orders, so 3 consecutive fully-old pages means ~30
// orders in a row with nothing in-window before giving up; that's a wide
// enough margin to absorb the kind of local interleaving actually observed
// (a handful of out-of-order cards near a boundary), while still bounding
// the walk for an old/large account that's genuinely out of relevant
// history. Same trade as the lookback floor in syncWindow.js: a few extra
// Amazon requests per sync in exchange for not silently losing orders.
const MAX_CONSECUTIVE_ALL_OLD_PAGES = 3;

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
  // sawOlder: at least one card on this page was dated before sinceDateStr.
  // anyInWindow: at least one card on this page was dated on/after
  // sinceDateStr -- judged purely by date, before any of the other
  // filters below (cancelled/returned text, promo cards, pickup orders)
  // get a chance to drop it from `orders`. That's deliberate: a page whose
  // in-window cards all happen to get filtered out for other reasons is
  // NOT evidence the page (or the account) is out of relevant history, so
  // it must not be treated the same as a page with no in-window cards at
  // all. See scrapeYear() for how these two flags are used.
  let sawOlder = false;
  let anyInWindow = false;
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
    if (orderDate.toISOString().split('T')[0] < sinceDateStr) { sawOlder = true; continue; }
    anyInWindow = true;

    // This card-wide regex is a real false-positive risk: it drops the
    // WHOLE order if any of these words appears anywhere on the card, not
    // just in an actual status badge -- a product title or promo banner
    // containing "Returned", "Refund Guarantee", etc. would silently make
    // an active order vanish from every sync, forever, with nothing to
    // explain why. Anchoring to Amazon's real status-badge element instead
    // would close that gap properly, but that needs live order-list HTML
    // (ideally one card with a genuine Cancelled/Returned/Refunded badge,
    // and one whose title/promo text merely contains one of these words but
    // isn't actually cancelled) to find the right selector -- not available
    // here, so not guessed at.
    //
    // What IS verifiable from this file alone: the product title (titleEl
    // below) is one of the most likely innocent sources of a false
    // positive, and it's already isolated by its own selector. Pulling
    // that extraction up here and excluding it from the text this regex
    // tests narrows the false-positive surface without depending on any
    // selector this file doesn't already use.
    const titleElForStatusCheck = card.querySelector(
      '[class*="product-title"],[class*="item-title"],[class*="yohtmlc-item"],[class*="a-link-normal"][href*="/dp/"],[data-component*="item"] a,a[href*="/dp/"],a[href*="/gp/product/"]'
    );
    const titleTextForStatusCheck = (titleElForStatusCheck?.textContent ?? '').trim();
    const statusCheckText = titleTextForStatusCheck ? cardText.split(titleTextForStatusCheck).join(' ') : cardText;
    if (/\b(cancelled|canceled|refunded|returned)\b/i.test(statusCheckText)) continue;

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

  return { orders, sawOlder, anyInWindow };
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

  // Scope to the actual charged-payment-method box(es) first — the whole
  // page can contain other "ending in ####" text (gift card balance, promo
  // card upsells, split-payment lines) earlier in the DOM than the real
  // charge, which used to win the first-match-wins search below. The
  // rewards-rate text ("Earns 5% back and extra 1% on...") lives in a
  // sibling supplemental box with the same class fragment, so scope to
  // ALL matching boxes, not just the first.
  const paymentBoxes = Array.from(document.querySelectorAll('[class*="paystationpaymentmethod"]'));
  const paymentSearchText = paymentBoxes.length > 0
    ? paymentBoxes.map(el => el.outerHTML).join(' ')
    : detailDocHtml;

  let paymentLast4;
  for (const pat of [
    /\bending\s+in\s+(\d{4})\b/i, /\bending\s+(\d{4})\b/i,
    /\*{2,}\s*(\d{4})\b/, /\bx{4,}\s*(\d{4})\b/i, /[•·․⋅●]{2,}\s*(\d{4})\b/,
  ]) {
    const m = paymentSearchText.match(pat);
    if (m) { paymentLast4 = m[1]; break; }
  }

  // Total effective cashback rate for the card actually used, per the
  // payment box's own "Earns X% back[, and extra Y% on ...]" text — this
  // is how Amazon Store Card's variable-bonus tiers (base / +Amazon Day /
  // +No-Rush / stacked) show up, and it's the only reliable signal for
  // picking the right rate-tier card when several saved cards share the
  // same last4 (same physical card, different bonus-rate entries).
  let paymentRatePercent;
  const rateMatch = paymentSearchText.match(/(?:Earns|Get)\s+(\d+(?:\.\d+)?)\s*%\s*back/i);
  if (rateMatch) {
    paymentRatePercent = parseFloat(rateMatch[1]);
    const extraMatches = paymentSearchText.matchAll(/extra\s+(\d+(?:\.\d+)?)\s*%/gi);
    for (const m of extraMatches) paymentRatePercent += parseFloat(m[1]);
  }

  const detailPageUrls = Array.from(document.querySelectorAll('a[href*="ship-track"], a[href*="progress-tracker"], a[href*="package-tracking"]'))
    .map(a => a.href)
    .filter(h => !/\/(preship|cancel-items?|return|refund|replacement)\b/i.test(h));

  const fromDetail = extractCarrierTracking(document);

  // TEMP DIAGNOSTIC (remove once paymentRatePercent matching is confirmed
  // working against real pages): capture what the rate regex actually saw,
  // only when we have a last4 but no rate -- lets us see the real payment
  // box markup without dumping full page HTML into the logs.
  const paymentDebugSnippet = (paymentLast4 && paymentRatePercent == null)
    ? paymentSearchText.slice(0, 1500)
    : undefined;

  return { notFound: false, title, address, cost, orderDate, noRushBonusPercent, paymentLast4, paymentRatePercent, paymentDebugSnippet, detailPageUrls, fromDetail };
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

// Walks every page of one year's order-history list (or the whole
// current-orders list when year is null), from newest to oldest.
//
// Returns whether the caller (syncAmazon's year-by-year walk-backward loop)
// should stop checking still-earlier years. That used to be "did the most
// recently scraped page contain any single card older than sinceDateStr",
// on the assumption that Amazon lists orders in strict newest-to-oldest
// order. That assumption doesn't hold: the order-history page can
// interleave subscription renewals, multi-item orders, and reorders, so an
// old-dated card can appear on the same page as -- or a page before -- a
// genuinely newer, in-window order. Stopping on the first old card meant
// pagination silently gave up before ever fetching a later page that had
// real in-window orders on it, with nothing in the logs naming what got
// skipped. (Order #872: docker logs confirmed it never entered the
// detail-fetch loop at all, i.e. it was lost right here.)
//
// Fixed shape: a page only counts as "nothing more to find here" when it
// contributes zero in-window orders (anyInWindow false), not merely when it
// contains an old card. A mixed page keeps paginating. To still bound the
// walk for an account whose history is genuinely exhausted, MAX_CONSECUTIVE_
// ALL_OLD_PAGES consecutive zero-in-window pages stops the walk (see that
// constant's comment for why 3). Stopping the earlier-years walk once this
// year's pages are exhausted (nextIndex == null) is still gated on having
// actually seen an older card somewhere in this year (everSawOlder) -- if
// this year never produced one, sinceDate must be further back, so earlier
// years still need checking.
async function scrapeYear(page, year, sinceDateISO, allOrders, seen) {
  let pageUrl = year != null ? `${ORDERS_URL}?timeFilter=year-${year}` : ORDERS_URL;
  let consecutiveAllOldPages = 0;
  let everSawOlder = false;
  while (allOrders.length < MAX_ORDERS) {
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded' });
    await waitForOrders(page);
    await sleep(1500);
    if (isLoggedOut(page)) throw new SessionExpiredError('amazon');

    const { orders, sawOlder, anyInWindow } = await page.evaluate(scrapeDocInBrowser, sinceDateISO);
    for (const o of orders) {
      if (!seen.has(o.orderNumber)) { seen.add(o.orderNumber); allOrders.push(o); }
    }
    if (sawOlder) everSawOlder = true;
    console.log(`[amazon] year=${year ?? 'current'} page scraped ${orders.length} orders, sawOlder=${sawOlder}, anyInWindow=${anyInWindow}, total=${allOrders.length}`);

    if (anyInWindow) {
      consecutiveAllOldPages = 0;
    } else {
      consecutiveAllOldPages++;
      if (consecutiveAllOldPages >= MAX_CONSECUTIVE_ALL_OLD_PAGES) {
        console.log(`[amazon] year=${year ?? 'current'} stopping: ${consecutiveAllOldPages} consecutive pages with no in-window orders`);
        return true; // safety cap hit — treat as having reached sinceDate, stop walking further back
      }
    }

    const nextIndex = await page.evaluate(getNextStartIndexInBrowser);
    if (nextIndex == null) return everSawOlder; // no more pages this year — only stop earlier years if this year actually reached sinceDate somewhere
    pageUrl = year != null
      ? `${ORDERS_URL}?startIndex=${nextIndex}&timeFilter=year-${year}`
      : `${ORDERS_URL}?startIndex=${nextIndex}`;
    await sleep(400);
  }
  return everSawOlder;
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
    paymentRatePercent: detail.paymentRatePercent,
    paymentDebugSnippet: detail.paymentDebugSnippet,
    noRushBonusPercent: detail.noRushBonusPercent,
    deliveryPhotoUrl,
  };
}

// Runs a full Amazon sync against an already-authenticated `page` (context
// loaded from the amazon-session.json storageState). Ported from
// amazon.ts's startSync()/runSync().
//
// The window this walks is by ORDER PLACED date, and `amazon_sidecar_last_sync`
// is stamped with today's date after every successful run -- so the
// incremental window used to be about 48 hours wide. An order placed a week
// ago that ships tonight fell outside it and never had its tracking number
// picked up, while orders that shipped the day after they were placed did.
// computeAmazonSinceDate now puts a floor under that; see
// sidecar/src/syncWindow.js for the floor and the trade it makes.
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

  // Locked orders used to be dropped here entirely on the theory that
  // "server rejects writes anyway — matches extension". That's no longer
  // true (if it ever was): /api/import's update path (app/api/import/route.ts)
  // has no `locked` guard at all — it's an unconditional prisma.order.update,
  // and its per-field logic already refuses to clobber protected data (cost/
  // salePrice/cashbackAmount only fill in when unset; a real tracking number
  // never gets overwritten by a worse one). So skipping the detail fetch here
  // bought nothing but a wasted round-trip, and cost something real: `locked`
  // is set automatically in several places completely unrelated to "don't
  // re-scrape this" — cancelling an order (app/api/orders/[id]/cancel/route.ts)
  // and BFMR marking an order paid (app/api/bfmr/sync-orders/route.ts, both on
  // the create path for brand-new orders and the update path for existing
  // ones) both set locked: true. An Amazon order that arrives via BFMR
  // already paid is CREATED locked — and the very same sync queues a
  // targeted SYNC_AMAZON_ORDER relink for it (see sidecar SYNC_AMAZON_ORDER
  // handling below) that would then no-op against its own fresh lock. Net
  // effect: any order that gets paid/locked before Amazon ever surfaces its
  // tracking number was excluded from every future sync, forever, with
  // nothing in the logs naming which order — a permanent, silent miss that
  // still reproduces regardless of how wide the sync window is.
  const orders = allOrders;

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
    if (detail.paymentRatePercent != null) order.paymentRatePercent = detail.paymentRatePercent;
    if (detail.paymentDebugSnippet) console.log(`[amazon] payment box snippet for #${order.orderNumber} (no rate matched): ${detail.paymentDebugSnippet}`);
    if (detail.noRushBonusPercent != null) order.noRushBonusPercent = detail.noRushBonusPercent;
    if (detail.orderDate && /T\d{2}:\d{2}/.test(detail.orderDate)) order.orderDate = detail.orderDate;
  }

  const filtered = orders.filter(o => !o._skipBusiness);
  for (const o of filtered) { delete o._listTrackingUrls; delete o._skipBusiness; }
  return filtered;
}

// Targeted re-scrape of specific order numbers — the sidecar side of the
// extension's SYNC_AMAZON_ORDER command (background/index.ts
// runAmazonOrderSync -> amazon.ts scrapeAmazonOrders). No list-page walk
// at all: the caller already knows which orders it wants refreshed, so
// this goes straight to each detail page.
//
// Difference from the extension: it wrapped each detail fetch in a 20s
// Promise.race timeout and pushed a stub row on timeout, which silently
// wrote a zero-cost order over real data. Here a failed detail fetch just
// drops that order from the batch — /api/import is create-or-update by
// order number, so omitting a row leaves the existing one untouched,
// which is the safe direction for money data.
async function syncAmazonOrders(page, orderNumbers) {
  const wanted = [...new Set((orderNumbers || []).filter(Boolean))];
  if (wanted.length === 0) {
    console.log('[amazon] SYNC_AMAZON_ORDER: no order numbers in payload');
    return [];
  }

  // No locked-order filtering here either (see the long comment in
  // syncAmazon above) — this path matters even more for the bug that
  // comment describes: app/api/bfmr/sync-orders/route.ts queues exactly
  // this command to backfill a brand-new Amazon order's cost/tracking
  // right after importing it from BFMR, and when that order arrived
  // already paid it was created with locked: true in the very same pass.
  // Skipping locked targets here meant that backfill fetch silently never
  // ran against its own fresh lock.
  const targets = wanted;

  const today = new Date().toISOString().split('T')[0];
  const orders = [];
  for (const orderNumber of targets) {
    console.log(`[amazon] SYNC_AMAZON_ORDER: fetching ${orderNumber}`);
    await sleep(DETAIL_FETCH_DELAY_MS);
    let detail;
    try {
      detail = await fetchOrderDetails(page, orderNumber, []);
    } catch (e) {
      if (e instanceof SessionExpiredError) throw e;
      console.warn(`[amazon] SYNC_AMAZON_ORDER: ${orderNumber} failed, leaving existing row untouched: ${e.message}`);
      continue;
    }
    if (detail.notFound) {
      console.warn(`[amazon] SYNC_AMAZON_ORDER: ${orderNumber} not found on this account — skipping`);
      continue;
    }
    orders.push({
      platform: 'Amazon',
      orderNumber,
      orderDate: detail.orderDate || today,
      itemDescription: detail.title || '',
      cost: detail.cost || 0,
      shippingCost: 0,
      shippingAddress: detail.address || '',
      trackingNumbers: detail.tracking || [],
      sourceUrl: `https://www.amazon.com/gp/your-account/order-details?orderID=${orderNumber}`,
      ...(detail.paymentLast4 ? { paymentLast4: detail.paymentLast4 } : {}),
      ...(detail.paymentRatePercent != null ? { paymentRatePercent: detail.paymentRatePercent } : {}),
      ...(detail.noRushBonusPercent != null ? { noRushBonusPercent: detail.noRushBonusPercent } : {}),
      ...(detail.deliveryPhotoUrl ? { deliveryPhotoUrl: detail.deliveryPhotoUrl } : {}),
    });
  }
  return orders;
}

// "Is this page actually logged in?" — used by loginFlow.waitForLogin to
// decide whether the human's manual login succeeded and the storageState
// should be saved. Anchored on signals that are stable across Amazon's
// frequent orders-page markup churn, OR'd together so any one of them is
// enough: (a) an order card rendered (the classic signal — kept for
// backward compatibility), (b) the account nav showing a signed-in state
// ("Hello, <name>" instead of "Hello, sign in"), or (c) a sign-out link.
function confirmLoggedIn(page) {
  return page.evaluate(() => {
    // (a) order cards rendered — the original detection signal.
    if (document.querySelectorAll('a[href*="orderID="], a[href*="orderId="], a[href*="order-details"], [data-testid*="orderGroup"], [data-testid*="order-card"], [data-testid*="orderCard"]').length > 0) {
      return true;
    }
    // (b) account nav signed-in state: the element exists and does NOT say "sign in".
    const nav = document.querySelector('#nav-link-accountList-nav-line-1') || document.querySelector('#nav-link-accountList');
    if (nav && !/sign\s*in/i.test(nav.textContent)) {
      return true;
    }
    // (c) a sign-out affordance exists.
    if (document.querySelectorAll('a[href*="/gp/flex/sign-out"], a[href*="signout"]').length > 0) {
      return true;
    }
    return false;
  }).catch(() => false);
}

module.exports = {
  syncAmazon, syncAmazonOrders, isLoggedOut, confirmLoggedIn, ORDERS_URL, computeAmazonSinceDate,
  scrapeYear, MAX_CONSECUTIVE_ALL_OLD_PAGES,
};
