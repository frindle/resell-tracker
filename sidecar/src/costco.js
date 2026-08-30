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
// Warehouse RECEIPTS are fetched actively (LIST over the sync window,
// then DETAIL per barcode), using the request shapes recorded in
// sidecar/costco-receipts-capture.md — captured off a live session, not
// guessed. That file is the source of truth for the query signatures,
// the documentType/documentSubType enum values, and the date format;
// read it before touching RECEIPT_LIST_QUERY / receiptDetailQuery below.
// Anything the interceptor happened to capture is merged in on top, so
// this is strictly a superset of the old capture-only behaviour.

const { SessionExpiredError, fetchLockedOrderNumbers } = require('./lib');
const syncWindow = require('./syncWindow.js');

const { computeSinceDate, COSTCO_COLD_START_DAYS, COSTCO_MIN_LOOKBACK_DAYS } = syncWindow;

const ORDERS_URL = 'https://www.costco.com/myaccount/';
// Overridable ONLY so tests can point the GraphQL replay at a local
// fixture server. Nothing in the container sets this, and it must stay
// unset in the deployment — a wrong value here silently sends an
// authenticated bearer token to somewhere that isn't Costco.
const GRAPHQL_URL = process.env.COSTCO_GRAPHQL_URL || 'https://ecom-api.costco.com/ebusiness/order/v1/orders/graphql';
const PAGE_SIZE = 16;
const MAX_PAGES = 40;
const CAPTURE_WAIT_MS = 30000;
const MAX_RECEIPT_DETAILS = 200;
const RECEIPT_DETAIL_DELAY_MS = 400;
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

// Receipt LIST. Signature and argument names are verbatim from the
// captured request (sidecar/costco-receipts-capture.md, Variant 1); the
// field selection is trimmed to what /api/costco/receipts and
// lib/costcoReceipt.ts actually read, which GraphQL allows.
const RECEIPT_LIST_QUERY = `query receiptsWithCounts($startDate: String!, $endDate: String!,$documentType:String!,$documentSubType:String!) {
  receiptsWithCounts(startDate: $startDate, endDate: $endDate,documentType:$documentType,documentSubType:$documentSubType) {
    receipts {
      warehouseName
      transactionDateTime
      transactionBarcode
      transactionType
      total
      totalItemCount
      itemArray { itemNumber }
      tenderArray { tenderTypeCode tenderDescription amountTender }
      couponArray { upcnumberCoupon }
    }
  }
}`;

// Receipt DETAIL (Variant 2). Two selection sets, because two fields the
// app renders on the receipt PDF -- instantSavings and membershipNumber
// (both declared optional on ReceiptData in lib/costcoReceipt.ts, both
// read by generateReceiptPdf) -- appear in the extension's never-executed
// query but NOT in the captured detail response. Selecting a field that
// doesn't exist fails the whole GraphQL request, so rather than guess
// either way: try the richer set once, and if the server rejects it, drop
// to the strictly-confirmed set and latch that choice for the rest of the
// run. Every field in the strict set is one the capture actually shows.
function receiptDetailQuery({ includeUnconfirmed }) {
  const extra = includeUnconfirmed ? '\n      instantSavings\n      membershipNumber' : '';
  return `query receiptsWithCounts($barcode: String!,$documentType:String!) {
  receiptsWithCounts(barcode: $barcode,documentType:$documentType) {
    receipts {
      warehouseName
      warehouseAddress1
      warehouseAddress2
      warehouseCity
      warehouseState
      warehousePostalCode
      transactionDate
      transactionDateTime
      registerNumber
      operatorNumber
      transactionNumber
      transactionBarcode
      transactionType
      subTotal
      taxes
      total
      totalItemCount${extra}
      itemArray {
        itemNumber
        itemDescription01
        itemDescription02
        itemIdentifier
        itemDepartmentNumber
        unit
        amount
        taxFlag
        itemUnitPriceAmount
      }
      tenderArray { tenderTypeCode tenderDescription amountTender }
      couponArray { upcnumberCoupon }
    }
  }
}`;
}

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

// The receipts endpoint wants a DIFFERENT date format from the orders
// endpoint: "6/01/2026" — single-digit MONTH, zero-padded DAY. This is
// not MM/DD/YYYY and a %m/%d/%Y formatter produces "06/01/2026", which is
// not what the site sends. Observed on the wire; see
// sidecar/costco-receipts-capture.md.
function formatReceiptDate(d) {
  return `${d.getMonth() + 1}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`;
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
  return computeSinceDate({
    lastSyncIso,
    coldStartDays: COSTCO_COLD_START_DAYS,
    minLookbackDays: COSTCO_MIN_LOOKBACK_DAYS,
    overlapMs: 24 * 60 * 60 * 1000,
    now
  });
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

// One GraphQL round-trip through the in-page XHR bridge. Returns
// { ok, status, data, errors } — note a GraphQL failure normally arrives
// as HTTP 200 with a populated `errors` array, so callers must check both.
async function runGraphql(page, auth, query, variables) {
  const body = JSON.stringify({ query, variables });
  const resp = await page.evaluate(costcoGraphqlInBrowser, {
    url: GRAPHQL_URL, token: auth.token, clientId: auth.clientId, body,
  });
  if (!resp || !resp.ok) {
    return { ok: false, status: resp ? resp.status : 0, data: null, errors: [{ message: `HTTP ${resp ? resp.status : '?'}` }] };
  }
  let json;
  try {
    json = JSON.parse(resp.text);
  } catch {
    return { ok: false, status: resp.status, data: null, errors: [{ message: 'unparseable JSON response' }] };
  }
  const errors = Array.isArray(json.errors) && json.errors.length > 0 ? json.errors : null;
  return { ok: !errors, status: resp.status, data: json.data || null, errors };
}

// receiptsWithCounts comes back as an OBJECT with a .receipts array (not
// the array-wrapped shape getOnlineOrders uses). Tolerate both.
function receiptsFrom(data) {
  const rc = data && data.receiptsWithCounts;
  if (!rc) return [];
  const node = Array.isArray(rc) ? rc[0] : rc;
  return (node && node.receipts) || [];
}

// Active receipt fetch: LIST over the sync window, then DETAIL per
// barcode. transactionBarcode from a LIST row is the barcode input to
// DETAIL — that join is what makes this work at all.
//
// Non-fatal by contract: every failure path returns whatever it has
// rather than throwing, because a receipts problem must never discard an
// otherwise-good order import.
async function fetchReceiptsViaGraphql(page, auth, sinceDate, now) {
  const startDate = formatReceiptDate(sinceDate);
  const endDate = formatReceiptDate(now);

  const list = await runGraphql(page, auth, RECEIPT_LIST_QUERY, {
    startDate,
    endDate,
    // Sent by the real UI alongside the declared arguments. It is NOT
    // referenced anywhere in the query body, so the resolver cannot see
    // it and it cannot narrow the date window — it is inert. Kept at the
    // observed literal rather than a computed label precisely because
    // deviating from a request shape that is known to work, on a hunch,
    // is how this kind of integration breaks.
    text: 'Last 3 Months',
    documentType: 'all',
    documentSubType: 'all',
  });

  if (!list.ok) {
    console.warn(`[costco] receipt LIST failed (HTTP ${list.status}): ${JSON.stringify(list.errors).slice(0, 300)}`);
    return [];
  }

  const summaries = receiptsFrom(list.data).filter(r => r && r.transactionBarcode);
  console.log(`[costco] receipt LIST ${startDate} → ${endDate}: ${summaries.length} receipt(s)`);
  if (summaries.length === 0) return [];

  // Start optimistic, fall back once, then stay fallen back.
  let includeUnconfirmed = true;
  const out = [];
  for (const summary of summaries.slice(0, MAX_RECEIPT_DETAILS)) {
    await sleep(RECEIPT_DETAIL_DELAY_MS);
    const barcode = summary.transactionBarcode;
    let detail = await runGraphql(page, auth, receiptDetailQuery({ includeUnconfirmed }), {
      barcode,
      documentType: 'warehouse',
    });

    if (!detail.ok && includeUnconfirmed) {
      console.warn(`[costco] receipt DETAIL rejected the optimistic field set (${JSON.stringify(detail.errors).slice(0, 200)}) — retrying with confirmed fields only, for this and every later receipt`);
      includeUnconfirmed = false;
      detail = await runGraphql(page, auth, receiptDetailQuery({ includeUnconfirmed }), {
        barcode,
        documentType: 'warehouse',
      });
    }

    if (!detail.ok) {
      // Keep the LIST summary: it still carries transactionBarcode,
      // transactionDateTime, warehouseName and total, which is everything
      // /api/costco/receipts needs to create and auto-link the row.
      console.warn(`[costco] receipt DETAIL for ${barcode} failed, keeping list summary: ${JSON.stringify(detail.errors).slice(0, 200)}`);
      out.push(summary);
      continue;
    }

    const full = receiptsFrom(detail.data)[0];
    out.push(full || summary);
  }

  if (summaries.length > MAX_RECEIPT_DETAILS) {
    console.warn(`[costco] ${summaries.length - MAX_RECEIPT_DETAILS} receipt(s) beyond the ${MAX_RECEIPT_DETAILS} cap were not detailed this run`);
  }
  return out;
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
    const resp = await runGraphql(page, auth, ORDER_QUERY, {
      startDate, endDate, pageNumber, pageSize: PAGE_SIZE, warehouseNumber,
    });
    if (!resp.ok) {
      console.warn(`[costco] GraphQL fallback page ${pageNumber} failed (HTTP ${resp.status}): ${JSON.stringify(resp.errors).slice(0, 200)}`);
      break;
    }
    const result = resp.data && resp.data.getOnlineOrders && resp.data.getOnlineOrders[0];
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

  // Receipts: actively query LIST + DETAIL (see the module header and
  // sidecar/costco-receipts-capture.md), then merge anything the
  // interceptor happened to capture on top. Dedupe by transactionBarcode,
  // preferring whichever record carries more fields — a DETAIL row beats
  // a LIST summary regardless of which path produced it.
  const auth = await page.evaluate(() => window.__costcoAuth || null);
  let fetched = [];
  if (auth) {
    try {
      fetched = await fetchReceiptsViaGraphql(page, auth, sinceDate, new Date());
    } catch (e) {
      console.warn(`[costco] active receipt fetch threw (non-fatal): ${e.message}`);
    }
  } else {
    console.warn('[costco] no intercepted auth token — receipts limited to whatever the page itself requested');
  }

  const capturedReceipts = await page.evaluate(() => {
    const list = window.__costcoReceiptList || [];
    const details = window.__costcoReceiptDetails || {};
    return list.map(r => details[r.transactionBarcode] || r);
  }).catch(() => []);

  const byBarcode = new Map();
  for (const r of [...fetched, ...capturedReceipts]) {
    if (!r || !r.transactionBarcode) continue;
    const prev = byBarcode.get(r.transactionBarcode);
    if (!prev || Object.keys(r).length > Object.keys(prev).length) {
      byBarcode.set(r.transactionBarcode, r);
    }
  }
  const receipts = [...byBarcode.values()];
  console.log(`[costco] receipts: ${fetched.length} fetched, ${capturedReceipts.length} captured, ${receipts.length} after merge`);

  return { orders, receipts };
}

module.exports = {
  syncCostco, isLoggedOut, installInterceptor, computeCostcoSinceDate,
  ORDERS_URL, mapOrder, formatReceiptDate, receiptsFrom, receiptDetailQuery,
  fetchReceiptsViaGraphql, RECEIPT_LIST_QUERY,
};
