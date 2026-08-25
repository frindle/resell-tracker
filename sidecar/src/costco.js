'use strict';

// Ported from resell-tracker-extension/src/content/costco.ts +
// src/content/costco-interceptor.ts + the Costco branches of
// src/background/index.ts (GET_CAPTURED_ORDERS / GET_CAPTURED_RECEIPTS /
// CYCLE_DATE_FILTER / COSTCO_GRAPHQL).
//
// Costco is NOT a DOM scrape. The orders page talks to
// ecom-api.costco.com over GraphQL with a bearer token that only Costco's
// own app can mint; every attempt in the extension to obtain that token
// independently (the /gettoken endpoint, MSAL acquireTokenSilent, the
// B2C refresh_token exchange) produced an id_token that ecom-api rejects
// with 401. See the getAuth() comment in costco.ts. The only thing that
// works is intercepting the token off Costco's own in-page requests.
//
// So this module reproduces the extension's architecture exactly:
//   1. An init script (Playwright's addInitScript == the extension's
//      MAIN-world document_start interceptor) wraps fetch + XHR before
//      any page script runs and stashes the auth headers plus every
//      GraphQL response body on `window`.
//   2. We navigate the real orders page and let Costco's own app fire
//      its own requests — this is also what gets us past Akamai, which
//      is why the extension preferred captured responses over its own
//      API calls.
//   3. We drive Costco's date-period <select> to make the app re-query
//      further back, accumulating pages.
//   4. Anything the capture missed falls back to replaying the same
//      GraphQL query through an in-page XHR with the captured token
//      (fetch gets 401 here, XHR gets 200 — extension's finding, kept).
//
// KNOWN GAP (deliberate, do not paper over): warehouse RECEIPTS are
// capture-only. The extension declared RECEIPT_LIST_QUERY /
// RECEIPT_DETAIL_QUERY but never called them — its receipts only ever
// arrived because the human happened to open the in-warehouse receipts
// tab while the interceptor was live. The documentType/documentSubType
// argument values those queries need appear nowhere in the extension or
// in any captured traffic in this repo, so there is nothing to port and
// nothing safe to guess. Unattended, this module will normally return
// zero receipts. See the sidecar section of the migration report.

const { SessionExpiredError, fetchLockedOrderNumbers } = require('./lib');

const ORDERS_URL = 'https://www.costco.com/myaccount/';
const GRAPHQL_URL = 'https://ecom-api.costco.com/ebusiness/order/v1/orders/graphql';
const PAGE_SIZE = 16;
const MAX_PAGES = 40;
const CAPTURE_WAIT_MS = 30000;
const SKIP_STATUSES = new Set(['cancelled', 'canceled']);
const DIGITAL_CARRIERS = new Set(['electronic delivery service', 'email delivery', 'email']);

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Ported verbatim in intent from costco.ts's ORDER_QUERY.
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

// ---------------------------------------------------------------------------
// In-page code (runs in the browser, not Node)
// ---------------------------------------------------------------------------

// Playwright's addInitScript runs before any page script on every
// navigation in the context — the same guarantee the extension got from
// a MAIN-world content script at document_start. Body is the extension's
// costco-interceptor.ts with the chrome-specific bits removed.
function costcoInterceptorSource() {
  return function () {
    if (window.__costcoInterceptorInstalled) return;
    window.__costcoInterceptorInstalled = true;

    function headersToPlain(h) {
      if (!h) return {};
      const out = {};
      if (typeof Headers !== 'undefined' && h instanceof Headers) {
        h.forEach((v, k) => { out[k.toLowerCase()] = v; });
        return out;
      }
      if (Array.isArray(h)) {
        for (const [k, v] of h) out[String(k).toLowerCase()] = v;
        return out;
      }
      for (const [k, v] of Object.entries(h)) out[String(k).toLowerCase()] = v;
      return out;
    }

    function tryCapture(url, headers) {
      if (!url || !url.includes('ecom-api.costco.com')) return;
      const auth = headers['costco-x-authorization'] || headers['authorization'] || '';
      const clientId = headers['costco-x-wcs-clientid'] || '';
      if (auth.startsWith('Bearer ') && clientId) {
        window.__costcoAuth = { token: auth.slice(7), clientId };
      }
    }

    function absorb(data) {
      try {
        const pages = data && data.data && data.data.getOnlineOrders;
        if (Array.isArray(pages)) {
          const existing = window.__costcoAllOrders || [];
          for (const page of pages) existing.push(page);
          window.__costcoAllOrders = existing;
        }
        const rc = data && data.data && data.data.receiptsWithCounts;
        if (rc) {
          const receipts = rc.receipts || [];
          const list = window.__costcoReceiptList || [];
          const details = window.__costcoReceiptDetails || {};
          if (receipts.length > 1) {
            for (const r of receipts) {
              if (r.transactionBarcode && !list.find(x => x.transactionBarcode === r.transactionBarcode)) list.push(r);
            }
          } else if (receipts.length === 1 && receipts[0] && receipts[0].transactionBarcode) {
            const r = receipts[0];
            const bc = r.transactionBarcode;
            const idx = list.findIndex(x => x.transactionBarcode === bc);
            if (idx >= 0) list[idx] = r; else list.push(r);
            details[bc] = r;
          }
          window.__costcoReceiptList = list;
          window.__costcoReceiptDetails = details;
        }
      } catch { /* never break the page */ }
    }

    const origFetch = window.fetch.bind(window);
    window.__origFetch = origFetch;
    window.fetch = async function (input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) ? input.url : String(input);
      tryCapture(url, headersToPlain(init && init.headers));
      const res = await origFetch(input, init);
      if (url.includes('ecom-api.costco.com') && res.ok && url.includes('order/v1/orders/graphql')) {
        res.clone().json().then(absorb).catch(() => {});
      }
      return res;
    };

    const origOpen = XMLHttpRequest.prototype.open;
    const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      this.__xhrUrl = url;
      this.__xhrHeaders = {};
      return origOpen.call(this, method, url, ...rest);
    };
    XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
      this.__xhrHeaders[String(name).toLowerCase()] = value;
      tryCapture(this.__xhrUrl || '', this.__xhrHeaders);
      return origSetHeader.call(this, name, value);
    };
    XMLHttpRequest.prototype.send = function (body) {
      const url = this.__xhrUrl || '';
      if (url.includes('ecom-api.costco.com')) {
        this.addEventListener('load', function () {
          if (this.status < 400 && url.includes('order/v1/orders/graphql')) {
            try { absorb(JSON.parse(this.responseText)); } catch { /* skip */ }
          }
        });
      }
      return origSend.call(this, body);
    };
  };
}

// Ported from background/index.ts inPageCycleDateFilter. Costco's orders
// page only queries the last 3 months on load; each further-back period
// is a separate app-issued query, and driving the <select> is how the
// extension made the app issue them.
function cycleDateFilterInBrowser(sinceDate) {
  const MONTHS = {
    january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
    july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
  };
  const since = new Date(sinceDate);
  const sel = document.getElementById('Showing');
  if (!sel) return -1;

  let clicked = 0;
  const run = async () => {
    for (let i = 1; i < sel.options.length; i++) {
      const text = sel.options[i].text.trim();
      const m = text.match(/^(\d{4})\s+(\w+)\s*-\s*(\w+)$/);
      if (!m) continue;
      const year = parseInt(m[1], 10);
      const endMonthIdx = MONTHS[m[3].toLowerCase()];
      if (endMonthIdx === undefined) continue;
      const periodEnd = new Date(year, endMonthIdx + 1, 0);
      if (periodEnd < since) break;

      const beforeLen = (window.__costcoAllOrders || []).length;
      sel.value = sel.options[i].value || text;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      clicked++;

      await new Promise(resolve => {
        let waited = 0;
        const interval = setInterval(() => {
          waited += 200;
          if ((window.__costcoAllOrders || []).length > beforeLen || waited >= 8000) {
            clearInterval(interval);
            resolve();
          }
        }, 200);
      });
      await new Promise(r => setTimeout(r, 400));
    }
    return clicked;
  };
  return run();
}

// Ported from background/index.ts inPageCostcoGraphql. XHR, not fetch —
// the extension found fetch gets 401 on this endpoint where XHR gets 200.
function costcoGraphqlInBrowser({ url, token, clientId, body }) {
  return new Promise(resolve => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.setRequestHeader('content-type', 'application/json-patch+json');
    xhr.setRequestHeader('costco-x-authorization', `Bearer ${token}`);
    xhr.setRequestHeader('costco-x-wcs-clientid', clientId);
    xhr.setRequestHeader('costco.env', 'ecom');
    xhr.setRequestHeader('costco.service', 'restOrders');
    xhr.setRequestHeader('client-identifier', crypto.randomUUID());
    xhr.onload = () => resolve({ ok: xhr.status < 400, status: xhr.status, text: xhr.responseText });
    xhr.onerror = () => resolve({ ok: false, status: 0, text: 'network error' });
    xhr.send(body);
  });
}

// Ported from costco.ts getWarehouseNumber().
function warehouseNumberInBrowser() {
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

// ---------------------------------------------------------------------------
// Node-side
// ---------------------------------------------------------------------------

function isLoggedOut(page) {
  const url = page.url();
  return /signin\.costco\.com|\/logon|LogonForm|\/login/i.test(url);
}

// Installs the interceptor on a context. Must be called before the first
// navigation, same as the extension's document_start injection.
async function installInterceptor(context) {
  await context.addInitScript(costcoInterceptorSource());
}

function formatDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Ported from costco.ts mapOrder().
function mapOrder(o) {
  if (SKIP_STATUSES.has((o.status || '').toLowerCase())) return null;
  const activeItems = (o.orderLineItems || []).filter(li => !SKIP_STATUSES.has((li.status || '').toLowerCase()));
  const descriptions = [...new Set(activeItems.map(li => (li.itemDescription || '').trim()).filter(Boolean))];
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
    itemDescription: descriptions.join(', ').slice(0, 200),
    cost: o.orderTotal,
    shippingCost: 0,
    shippingAddress: '',
    trackingNumbers: tracking,
    sourceUrl: `https://www.costco.com/myaccount/#/app/4900eb1f-0c10-4bd9-99c3-c59e6c1ecebf/orderdetails/${o.orderNumber}`,
  };
}

// The extension's 90-day floor with no overlap-buffer concept of its own
// (costco.ts used settings.costcoLastSync directly). Keep that, but add
// the same 1-day overlap the Amazon path uses so an order that landed
// late on the last-sync day isn't skipped forever.
function computeCostcoSinceDate(lastSyncIso, now = new Date()) {
  const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
  if (!lastSyncIso) return ninetyDaysAgo;
  const lastSync = new Date(lastSyncIso);
  if (isNaN(lastSync.getTime())) return ninetyDaysAgo;
  return new Date(lastSync.getTime() - 24 * 60 * 60 * 1000);
}

async function waitForCapture(page, timeoutMs = CAPTURE_WAIT_MS) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const state = await page.evaluate(() => ({
      auth: !!window.__costcoAuth,
      pages: (window.__costcoAllOrders || []).length,
      hasSelect: !!document.getElementById('Showing'),
    })).catch(() => ({ auth: false, pages: 0, hasSelect: false }));
    if (state.pages > 0 || (state.auth && state.hasSelect)) return state;
    await sleep(500);
  }
  return page.evaluate(() => ({
    auth: !!window.__costcoAuth,
    pages: (window.__costcoAllOrders || []).length,
    hasSelect: !!document.getElementById('Showing'),
  })).catch(() => ({ auth: false, pages: 0, hasSelect: false }));
}

// Fallback path: replay the same query the app issues, using the token we
// intercepted, through an in-page XHR. Only used when the capture path
// produced nothing.
async function fetchOrdersViaGraphql(page, auth, startDate, endDate) {
  const warehouseNumber = (await page.evaluate(warehouseNumberInBrowser).catch(() => '')) || '0';
  const orders = [];
  let pageNumber = 1;
  let total = Infinity;
  while ((pageNumber - 1) * PAGE_SIZE < total && pageNumber <= MAX_PAGES) {
    if (pageNumber > 1) await sleep(600);
    const body = JSON.stringify({
      query: ORDER_QUERY,
      variables: { startDate, endDate, pageNumber, pageSize: PAGE_SIZE, warehouseNumber },
    });
    const resp = await page.evaluate(costcoGraphqlInBrowser, {
      url: GRAPHQL_URL, token: auth.token, clientId: auth.clientId, body,
    });
    if (!resp || !resp.ok) {
      console.warn(`[costco] GraphQL fallback page ${pageNumber} failed: HTTP ${resp ? resp.status : '?'}`);
      break;
    }
    let json;
    try { json = JSON.parse(resp.text); } catch { break; }
    const result = json && json.data && json.data.getOnlineOrders && json.data.getOnlineOrders[0];
    if (!result) {
      console.warn('[costco] GraphQL fallback: unexpected response shape');
      break;
    }
    total = result.totalNumberOfRecords ?? 0;
    orders.push(...(result.bcOrders || []));
    pageNumber++;
  }
  return orders;
}

// Runs a full Costco sync against an already-authenticated `page` whose
// context had installInterceptor() applied. Returns { orders, receipts }
// — poll.js pushes orders to /api/import and receipts to
// /api/costco/receipts, mirroring what the extension's costco.ts did in
// one function.
async function syncCostco(page, { lastSyncIso }) {
  const sinceDate = computeCostcoSinceDate(lastSyncIso);
  const startDate = formatDate(sinceDate);
  const endDate = formatDate(new Date());
  console.log(`[costco] syncing ${startDate} → ${endDate}`);

  await page.goto(ORDERS_URL, { waitUntil: 'domcontentloaded' });
  if (isLoggedOut(page)) throw new SessionExpiredError('costco');

  const captured = await waitForCapture(page);
  if (isLoggedOut(page)) throw new SessionExpiredError('costco');
  console.log(`[costco] initial capture: auth=${captured.auth} pages=${captured.pages} dateSelect=${captured.hasSelect}`);

  if (!captured.auth && captured.pages === 0) {
    // Nothing intercepted at all. The extension treats this the same way
    // ("hard-refresh the orders page") — it is indistinguishable from a
    // dead session from the outside, and there is no independent way to
    // mint the token, so failing loudly beats importing nothing silently.
    throw new SessionExpiredError('costco');
  }

  if (captured.hasSelect) {
    const cycled = await page.evaluate(cycleDateFilterInBrowser, startDate).catch(e => {
      console.warn('[costco] date-filter cycling failed:', e.message);
      return -1;
    });
    console.log(`[costco] date-filter cycling selected ${cycled} extra period(s)`);
  }

  const rawPages = await page.evaluate(() => window.__costcoAllOrders || []);
  let bcOrders = [];
  for (const p of rawPages) bcOrders.push(...((p && p.bcOrders) || []));

  if (bcOrders.length === 0) {
    const auth = await page.evaluate(() => window.__costcoAuth || null);
    if (auth) {
      console.log('[costco] no captured orders — falling back to in-page GraphQL replay');
      bcOrders = await fetchOrdersViaGraphql(page, auth, startDate, endDate);
    }
  }

  const seen = new Set();
  let orders = [];
  for (const o of bcOrders) {
    const mapped = mapOrder(o);
    if (!mapped || !mapped.orderNumber || seen.has(mapped.orderNumber)) continue;
    seen.add(mapped.orderNumber);
    orders.push(mapped);
  }

  const before = orders.length;
  orders = orders.filter(o => o.orderDate && new Date(o.orderDate) >= sinceDate);
  console.log(`[costco] ${before} order(s) captured, ${orders.length} on/after ${startDate}`);

  const locked = await fetchLockedOrderNumbers('costco');
  if (locked.size > 0) {
    const n = orders.length;
    orders = orders.filter(o => !locked.has(o.orderNumber));
    console.log(`[costco] skipping ${n - orders.length} locked order(s); ${orders.length} remain`);
  }

  // Capture-only — see the module header for why there is no active
  // receipts query here.
  const receipts = await page.evaluate(() => {
    const list = window.__costcoReceiptList || [];
    const details = window.__costcoReceiptDetails || {};
    return list.map(r => details[r.transactionBarcode] || r);
  }).catch(() => []);
  console.log(`[costco] ${receipts.length} warehouse receipt(s) captured`);

  return { orders, receipts };
}

module.exports = {
  syncCostco, isLoggedOut, installInterceptor, computeCostcoSinceDate,
  ORDERS_URL, mapOrder,
};
