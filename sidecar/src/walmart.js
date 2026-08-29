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

const { SessionExpiredError, fetchLockedOrderNumbers } = require('./lib');

const ORDERS_URL = 'https://www.walmart.com/orders';
const MAX_PAGES = 20;
const MAX_ORDERS = 200;
const DETAIL_FETCH_DELAY_MS = 400;

const sleep = ms => new Promise(r => setTimeout(r, ms));

function isLoggedOut(page) {
  const url = page.url();
  return /\/account\/login|\/account\/signin/i.test(url);
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

  return { orders, hasOlder };
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

  let orderDate = null;
  let cost = null;
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
    address, tracking: [...numbers], isStoreDelivery, orderDate, cost, itemDescription,
    paymentLast4, deliveryPhotoUrl, deliveryPhotoBase64, deliveryPhotoMime,
  };
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
  return lastSyncIso
    ? new Date(new Date(lastSyncIso).getTime() - 48 * 60 * 60 * 1000)
    : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
}

async function syncWalmart(page, { lastSyncIso }) {
  const sinceDate = computeWalmartSinceDate(lastSyncIso);
  const sinceDateISO = sinceDate.toISOString();
  console.log(`[walmart] syncing since ${sinceDateISO.slice(0, 10)}`);

  await page.goto(ORDERS_URL, { waitUntil: 'domcontentloaded' });
  if (isLoggedOut(page)) throw new SessionExpiredError('walmart');
  await waitForOrdersToLoad(page, '');

  const allOrders = [];
  const seen = new Set();
  let pageNum = 1;

  while (pageNum <= MAX_PAGES && allOrders.length < MAX_ORDERS) {
    const { orders, hasOlder } = await page.evaluate(scrapeCurrentPageInBrowser, sinceDateISO);
    for (const o of orders) {
      if (!seen.has(o.orderNumber)) { seen.add(o.orderNumber); allOrders.push(o); }
    }
    console.log(`[walmart] page ${pageNum} scraped ${orders.length}, total=${allOrders.length}, hasOlder=${hasOlder}`);
    if (hasOlder) break;

    const fingerprint = await page.evaluate(getFirstBlockFingerprintInBrowser);
    const clicked = await page.evaluate(clickNextPageInBrowser);
    if (!clicked) break;
    await waitForOrdersToLoad(page, fingerprint);
    pageNum++;
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
    if (isLoggedOut(page)) throw new SessionExpiredError('walmart');
    const detail = await page.evaluate(extractDetailInBrowser);
    if (detail.address) order.shippingAddress = detail.address;
    if (detail.tracking.length) order.trackingNumbers = detail.tracking.filter(t => t !== order.orderNumber);
    else if (detail.isStoreDelivery) order.trackingNumbers = [order.orderNumber];
    if (detail.cost != null && detail.cost > 0 && order.cost === 0) order.cost = detail.cost;
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

module.exports = { syncWalmart, isLoggedOut, ORDERS_URL, computeWalmartSinceDate };
