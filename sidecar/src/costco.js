'use strict';

// Ported from resell-tracker-extension/src/content/costco.ts +
// costco-interceptor.ts. Like amazon.js/walmart.js this is a port, not a
// rewrite: the GraphQL queries, the bcOrder→ImportRow mapping, the
// warehouse-number heuristic and the ecom-api auth-capture trick are copied
// from the extension.
//
// Why the auth dance exists (unchanged from the extension's own comments):
// ecom-api.costco.com rejects the MSAL id_token with 401 — the ONLY token it
// accepts is the short-lived access token Costco's own SPA puts on its
// `costco-x-authorization` header. The extension captured that by wrapping
// fetch+XHR in the page (MAIN world at document_start). Playwright's
// page.addInitScript runs a script in the page's main world before any page
// script, so we inject the exact same interceptor here and then read the
// token it stashes on `window.__costcoAuth`.
//
// What differs from the extension, and why:
//  - The extension preferred orders *captured* from the SPA's own calls
//    (to dodge Akamai bot-detection on a fresh request) and only fell back
//    to direct GraphQL. Here there is no human clicking the date-range
//    dropdown, so we PROMOTE the direct-GraphQL path to primary: once we
//    hold a real captured token we page through getOnlineOrders ourselves
//    with in-page XHRs (same-origin, same headers as the SPA — not a fresh
//    cross-origin request, so Akamai sees the page making its own calls).
//    Any orders the SPA already captured on load are merged in on top.
//  - chrome.runtime messaging / badges / progress events are gone, replaced
//    by console.log which poll.js forwards to docker logs.

const { SessionExpiredError, fetchLockedOrderNumbers, pushCostcoReceipts } = require('./lib');

// The myaccount SPA is what fires the ecom-api order calls we piggy-back on.
// NOTE: Costco hash-routes order detail as #/app/<guid>/orderdetails/<n>, but
// the list view under /myaccount is what issues getOnlineOrders on load. If
// Costco moves this route, the auth-capture wait below fails LOUDLY (throws)
// rather than silently importing nothing — see waitForAuth.
const ORDERS_URL = 'https://www.costco.com/myaccount/ordersandpurchases';
const GRAPHQL_URL = 'https://ecom-api.costco.com/ebusiness/order/v1/orders/graphql';
const PAGE_SIZE = 16;
const MAX_PAGES = 40; // hard stop: 40 * 16 = 640 orders
const SKIP_STATUSES = new Set(['cancelled', 'canceled']);
const DIGITAL_CARRIERS = new Set(['electronic delivery service', 'email delivery', 'email']);

const ORDER_QUERY = `query getOnlineOrders($startDate:String!, $endDate:String!, $pageNumber:Int, $pageSize:Int, $warehouseNumber:String!) {
  getOnlineOrders(startDate:$startDate, endDate:$endDate, pageNumber:$pageNumber, pageSize:$pageSize, warehouseNumber:$warehouseNumber) {
    pageNumber
    pageSize
    totalNumberOfRecords
    bcOrders {
      orderHeaderId
      orderPlacedDate: orderedDate
      orderNumber: sourceOrderNumber
      orderTotal
      warehouseNumber
      status
      orderLineItems {
        itemDescription
        status
        carrierItemCategory
        shipment {
          trackingNumber
          carrierName
        }
      }
    }
  }
}`;

const sleep = ms => new Promise(r => setTimeout(r, ms));

function formatDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Interceptor injected via page.addInitScript (runs in the page's MAIN world
// before page scripts, same as the extension's document_start MAIN-world
// content script). Captures: the ecom-api access token + clientId, every
// getOnlineOrders page the SPA loads, and every receiptsWithCounts payload —
// plus the raw request template of the SPA's own receipt call so we can
// replay the *detail* query (with tenderArray) using the SPA's real
// documentType values instead of guessing them.
// ---------------------------------------------------------------------------
function interceptorSource() {
  /* eslint-disable */
  (function () {
    var origFetch = window.fetch ? window.fetch.bind(window) : null;

    function headersToPlain(h) {
      var out = {};
      if (!h) return out;
      if (typeof Headers !== 'undefined' && h instanceof Headers) { h.forEach(function (v, k) { out[String(k).toLowerCase()] = v; }); return out; }
      if (Array.isArray(h)) { h.forEach(function (p) { out[String(p[0]).toLowerCase()] = p[1]; }); return out; }
      Object.keys(h).forEach(function (k) { out[k.toLowerCase()] = h[k]; });
      return out;
    }

    function tryCapture(url, headers) {
      if (!url || url.indexOf('ecom-api.costco.com') === -1) return;
      var auth = headers['costco-x-authorization'] || headers['authorization'] || '';
      var clientId = headers['costco-x-wcs-clientid'] || '';
      if (auth.indexOf('Bearer ') === 0 && clientId) {
        window.__costcoAuth = { token: auth.slice(7), clientId: clientId };
      }
    }

    function absorbGraphql(text, reqBody) {
      try {
        var data = JSON.parse(text);
        var d = data && data.data ? data.data : {};
        var pages = d.getOnlineOrders;
        if (Array.isArray(pages)) {
          var existing = window.__costcoAllOrders || [];
          for (var i = 0; i < pages.length; i++) existing.push(pages[i]);
          window.__costcoAllOrders = existing;
        }
        var rc = d.receiptsWithCounts;
        if (rc) {
          var receipts = rc.receipts || [];
          var list = window.__costcoReceiptList || [];
          var details = window.__costcoReceiptDetails || {};
          if (receipts.length > 1) {
            for (var j = 0; j < receipts.length; j++) {
              var r = receipts[j];
              if (r.transactionBarcode && !list.some(function (x) { return x.transactionBarcode === r.transactionBarcode; })) list.push(r);
            }
          } else if (receipts.length === 1 && receipts[0] && receipts[0].transactionBarcode) {
            var one = receipts[0];
            var bc = one.transactionBarcode;
            var idx = -1;
            for (var k = 0; k < list.length; k++) { if (list[k].transactionBarcode === bc) { idx = k; break; } }
            if (idx >= 0) list[idx] = one; else list.push(one);
            details[bc] = one;
          }
          window.__costcoReceiptList = list;
          window.__costcoReceiptDetails = details;
          // Stash the SPA's own receipt request so we can replay the detail
          // query with its real documentType/documentSubType.
          if (reqBody && reqBody.indexOf('receiptsWithCounts') !== -1) {
            window.__costcoReceiptReqTemplate = reqBody;
          }
        }
      } catch (e) { /* ignore */ }
    }

    if (origFetch) {
      window.fetch = function (input, init) {
        var url = typeof input === 'string' ? input : (input && input.url) ? input.url : String(input);
        tryCapture(url, headersToPlain(init && init.headers));
        return origFetch(input, init).then(function (res) {
          if (url.indexOf('order/v1/orders/graphql') !== -1 && res.ok) {
            var body = (init && typeof init.body === 'string') ? init.body : '';
            res.clone().text().then(function (t) { absorbGraphql(t, body); }).catch(function () {});
          }
          return res;
        });
      };
    }

    var origOpen = XMLHttpRequest.prototype.open;
    var origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
    var origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
      this.__xhrUrl = url; this.__xhrHeaders = {};
      return origOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
      this.__xhrHeaders[String(name).toLowerCase()] = value;
      tryCapture(this.__xhrUrl || '', this.__xhrHeaders);
      return origSetHeader.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function (body) {
      var url = this.__xhrUrl || '';
      if (url.indexOf('ecom-api.costco.com') !== -1) {
        var reqBody = typeof body === 'string' ? body : '';
        this.addEventListener('load', function () {
          if (this.status < 400 && url.indexOf('order/v1/orders/graphql') !== -1) {
            absorbGraphql(this.responseText, reqBody);
          }
        });
      }
      return origSend.apply(this, arguments);
    };
  })();
  /* eslint-enable */
}

// In-page XHR to the ecom-api GraphQL endpoint, using the captured token.
// XHR (not fetch) matches the SPA — the extension found fetch got 401 while
// XHR got 200 from Akamai. Runs via page.evaluate.
function inPageGraphql(args) {
  const { token, clientId, url, body } = args;
  return new Promise(resolve => {
    try {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', url);
      xhr.setRequestHeader('content-type', 'application/json-patch+json');
      xhr.setRequestHeader('costco-x-authorization', `Bearer ${token}`);
      xhr.setRequestHeader('costco-x-wcs-clientid', clientId);
      xhr.setRequestHeader('costco.env', 'ecom');
      xhr.setRequestHeader('costco.service', 'restOrders');
      xhr.setRequestHeader('client-identifier', (crypto.randomUUID ? crypto.randomUUID() : String(Date.now())));
      xhr.onload = () => resolve({ ok: xhr.status < 400, status: xhr.status, text: xhr.responseText });
      xhr.onerror = () => resolve({ ok: false, status: 0, text: 'network error' });
      xhr.send(body);
    } catch (e) {
      resolve({ ok: false, status: 0, text: String(e) });
    }
  });
}

function getWarehouseNumberInBrowser() {
  for (const cookie of document.cookie.split(';')) {
    const [k, v] = cookie.trim().split('=');
    if (/store|warehouse|wh/i.test(k) && v && /^\d{3,4}$/.test(v.trim())) return v.trim();
  }
  for (const key of Object.keys(localStorage)) {
    if (/store|warehouse|wh/i.test(key)) {
      const v = localStorage.getItem(key) || '';
      if (/^\d{3,4}$/.test(v.trim())) return v.trim();
    }
  }
  return '';
}

// bcOrder → ImportRow. The 9 fields the extension sent for Costco:
// platform, orderNumber, orderDate, itemDescription, cost, shippingCost,
// shippingAddress, trackingNumbers, sourceUrl. (No paymentLast4 etc — Costco
// online orders don't expose them, matching the extension.)
function mapOrder(o) {
  if (SKIP_STATUSES.has((o.status || '').toLowerCase())) return null;
  const activeItems = (o.orderLineItems || []).filter(li => !SKIP_STATUSES.has((li.status || '').toLowerCase()));

  const descriptions = [...new Set(activeItems.map(li => (li.itemDescription || '').trim()).filter(Boolean))];
  const itemDescription = descriptions.join(', ').slice(0, 200);

  const tracking = [...new Set(
    activeItems
      .flatMap(li => li.shipment || [])
      .filter(s => s.trackingNumber && !DIGITAL_CARRIERS.has((s.carrierName || '').toLowerCase()))
      .map(s => s.trackingNumber),
  )];

  return {
    platform: 'Costco',
    orderNumber: o.orderNumber,
    orderDate: (o.orderPlacedDate || '').split('T')[0],
    itemDescription,
    cost: o.orderTotal,
    shippingCost: 0,
    shippingAddress: '',
    trackingNumbers: tracking,
    sourceUrl: `https://www.costco.com/myaccount/#/app/4900eb1f-0c10-4bd9-99c3-c59e6c1ecebf/orderdetails/${o.orderNumber}`,
  };
}

function isLoggedOut(page) {
  return /signin\.costco\.com|\/logon|\/login/i.test(page.url());
}

// Poll window.__costcoAuth until the SPA has fired its first ecom-api call
// and the interceptor grabbed a token. Fails LOUDLY on timeout — a silent
// "0 orders" would repeat the SYNC_AMAZON_ORDER mistake.
async function waitForAuth(page, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (isLoggedOut(page)) throw new SessionExpiredError('costco');
    const auth = await page.evaluate(() => window.__costcoAuth || null).catch(() => null);
    if (auth && auth.token && auth.clientId) return auth;
    await sleep(1000);
  }
  throw new Error(
    'Costco auth token was never captured — the myaccount orders page did not ' +
    `issue an ecom-api call within ${timeoutMs}ms. Verify ORDERS_URL (${ORDERS_URL}) ` +
    'still lands on the orders list, or that the session is still valid.',
  );
}

async function fetchOrderPage(page, auth, warehouseNumber, startDate, endDate, pageNumber) {
  const body = JSON.stringify({
    query: ORDER_QUERY,
    variables: { startDate, endDate, pageNumber, pageSize: PAGE_SIZE, warehouseNumber },
  });
  const resp = await page.evaluate(inPageGraphql, { token: auth.token, clientId: auth.clientId, url: GRAPHQL_URL, body });
  if (!resp || !resp.ok) {
    console.warn(`[costco] getOnlineOrders page ${pageNumber} failed: HTTP ${resp && resp.status}`);
    return null;
  }
  let json;
  try { json = JSON.parse(resp.text); } catch { return null; }
  const result = json && json.data && json.data.getOnlineOrders && json.data.getOnlineOrders[0];
  if (!result) return null;
  return { orders: result.bcOrders || [], total: result.totalNumberOfRecords || 0 };
}

// Best-effort: push whatever warehouse receipts the SPA loaded (list +
// details) to the existing /api/costco/receipts endpoint, and — when we
// captured the SPA's own receipt request — replay the detail query per
// barcode so each receipt carries its tenderArray (needed for the
// gift-card in-warehouse auto-import; see /api/costco/receipts server side).
async function syncReceipts(page, auth) {
  let captured;
  try {
    captured = await page.evaluate(() => ({
      list: window.__costcoReceiptList || [],
      details: window.__costcoReceiptDetails || {},
      template: window.__costcoReceiptReqTemplate || null,
    }));
  } catch {
    return { linked: 0, unlinked: 0, skipped: 0, sent: 0 };
  }

  const list = captured.list || [];
  const details = captured.details || {};

  // If the SPA issued a receipts call we can learn its real documentType(s)
  // from and replay the detail query for barcodes we don't yet have a detail
  // for. No hardcoded documentType guesses — we reuse what the SPA sent.
  if (captured.template) {
    let tmpl;
    try { tmpl = JSON.parse(captured.template); } catch { tmpl = null; }
    const documentType = tmpl && tmpl.variables && tmpl.variables.documentType;
    const detailQuery = `query receiptsWithCounts($barcode: String!, $documentType: String!) {
  receiptsWithCounts(barcode: $barcode, documentType: $documentType) {
    receipts {
      warehouseName warehouseAddress1 warehouseAddress2 warehouseCity warehouseState warehousePostalCode
      transactionDateTime transactionDate warehouseNumber
      total subTotal taxes instantSavings membershipNumber
      registerNumber transactionNumber operatorNumber transactionBarcode
      itemArray { itemNumber itemDescription01 itemDescription02 unit amount itemUnitPriceAmount taxFlag }
      tenderArray { tenderTypeCode tenderDescription amountTender }
    }
  }
}`;
    if (documentType) {
      for (const r of list) {
        const bc = r.transactionBarcode;
        if (!bc || details[bc]) continue;
        const body = JSON.stringify({ query: detailQuery, variables: { barcode: bc, documentType } });
        const resp = await page.evaluate(inPageGraphql, { token: auth.token, clientId: auth.clientId, url: GRAPHQL_URL, body });
        if (resp && resp.ok) {
          try {
            const json = JSON.parse(resp.text);
            const detail = json && json.data && json.data.receiptsWithCounts && json.data.receiptsWithCounts.receipts && json.data.receiptsWithCounts.receipts[0];
            if (detail && detail.transactionBarcode) details[detail.transactionBarcode] = detail;
          } catch { /* ignore */ }
        }
        await sleep(400);
      }
    }
  }

  // Prefer full detail (with tenderArray) over the list row.
  const toSend = list.map(r => details[r.transactionBarcode] || r).filter(r => r && r.transactionBarcode);
  if (toSend.length === 0) return { linked: 0, unlinked: 0, skipped: 0, sent: 0 };

  const result = await pushCostcoReceipts(toSend);
  console.log(`[costco] receipts pushed: ${toSend.length}`, result);
  return { ...result, sent: toSend.length };
}

// Full Costco sync against an already-authenticated `page` (context loaded
// from costco-session.json). lastSyncIso overlaps by a day like the others;
// the extension floored at 90 days, kept here.
function computeCostcoSinceDate(lastSyncIso, now = new Date()) {
  const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
  const lastSyncDate = lastSyncIso ? new Date(lastSyncIso) : null;
  return !lastSyncDate
    ? ninetyDaysAgo
    : lastSyncDate < ninetyDaysAgo
      ? lastSyncDate
      : new Date(lastSyncDate.getTime() - 24 * 60 * 60 * 1000);
}

async function syncCostco(page, { lastSyncIso }) {
  await page.addInitScript(interceptorSource);

  await page.goto(ORDERS_URL, { waitUntil: 'domcontentloaded' });
  if (isLoggedOut(page)) throw new SessionExpiredError('costco');

  const auth = await waitForAuth(page);
  const warehouseNumber = (await page.evaluate(getWarehouseNumberInBrowser).catch(() => '')) || '0';

  const sinceDate = computeCostcoSinceDate(lastSyncIso);
  const startDate = formatDate(sinceDate);
  const endDate = formatDate(new Date());
  console.log(`[costco] syncing ${startDate} → ${endDate} (warehouse ${warehouseNumber})`);

  const byNumber = new Map();
  const add = bc => { const m = mapOrder(bc); if (m && m.orderNumber && !byNumber.has(m.orderNumber)) byNumber.set(m.orderNumber, m); };

  // 1) Anything the SPA already captured on load.
  const capturedPages = await page.evaluate(() => window.__costcoAllOrders || []).catch(() => []);
  for (const p of capturedPages) for (const bc of (p.bcOrders || [])) add(bc);
  console.log(`[costco] captured ${byNumber.size} order(s) from SPA load`);

  // 2) Direct GraphQL pagination (primary path — see header comment).
  let pageNumber = 1;
  let total = Infinity;
  while ((pageNumber - 1) * PAGE_SIZE < total && pageNumber <= MAX_PAGES) {
    if (pageNumber > 1) await sleep(600);
    const pageData = await fetchOrderPage(page, auth, warehouseNumber, startDate, endDate, pageNumber);
    if (!pageData) break;
    total = pageData.total;
    for (const bc of pageData.orders) add(bc);
    console.log(`[costco] page ${pageNumber}: ${pageData.orders.length} orders (total reported ${total}, kept ${byNumber.size})`);
    pageNumber++;
  }

  // Filter to orders on/after sinceDate, matching the extension.
  let orders = [...byNumber.values()].filter(o => o.orderDate && new Date(o.orderDate) >= sinceDate);

  // Skip locked orders — server rejects writes anyway.
  const locked = await fetchLockedOrderNumbers('costco');
  if (locked.size > 0) {
    const before = orders.length;
    orders = orders.filter(o => !locked.has(o.orderNumber));
    console.log(`[costco] skipping ${before - orders.length} locked order(s); ${orders.length} remain`);
  }

  // Warehouse receipts are a side channel to a different endpoint; push them
  // here rather than through poll.js's /api/import path. Non-fatal.
  try {
    await syncReceipts(page, auth);
  } catch (e) {
    console.warn('[costco] receipt sync failed (non-fatal):', e.message);
  }

  return orders;
}

module.exports = { syncCostco, isLoggedOut, ORDERS_URL, computeCostcoSinceDate };
