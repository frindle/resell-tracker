'use strict';

// Ported from resell-tracker-extension/src/content/cashbackmonitor.ts +
// the runScrapeCbm()/CBM_SCRAPE_DONE pair in src/background/index.ts.
//
// This is the one extension job that never needed a logged-in session at
// all: cashbackmonitor.com store pages are public. The extension only ran
// it in a browser because a content script was the tool it had, and it
// routed the POST through the background worker purely to dodge CBM's CSP
// — neither constraint exists here. We still use a real browser page
// rather than a bare HTTP fetch because the rates are rendered by the
// page's own JS (the content script deliberately waited for `load` before
// parsing), so an HTML-only fetch would parse an empty table.
//
// Session-free by design: the caller passes a context created WITHOUT a
// storageState, so no Amazon/Walmart/Costco cookies are ever sent to
// cashbackmonitor.com.

const MERCHANT_TIMEOUT_MS = 20000;
const BETWEEN_MERCHANTS_MS = 750;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Ported verbatim from cashbackmonitor.ts parseTables().
function parseTablesInBrowser() {
  const rates = [];
  let currentCategory = null;

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT, null);
  let node = walker.nextNode();
  while (node) {
    const el = node;
    if (/^H[2-4]$/i.test(el.tagName) || el.classList.contains('cbm-section-title') || el.classList.contains('cbm_tab_title')) {
      const text = (el.textContent || '').trim();
      if (text && text.length < 60) {
        currentCategory = text.toLowerCase() === 'cashback' ? null : text;
      }
    }
    if (el.tagName === 'TABLE' && el.classList.contains('cbm2')) {
      const rows = el.querySelectorAll('tr');
      rows.forEach(row => {
        const cells = row.querySelectorAll('td.l');
        if (cells.length < 2) return;
        const portalAnchor = cells[1] && cells[1].querySelector('a[href*="/go-to/"]');
        const portal = portalAnchor && portalAnchor.textContent ? portalAnchor.textContent.trim() : null;
        const rateSpan = cells[2] && cells[2].querySelector('span[id^="ra"]');
        const rate = rateSpan && rateSpan.textContent ? rateSpan.textContent.trim() : null;
        if (portal && rate && rate !== 'n/a' && rate !== 'N/A') {
          rates.push({ portal, rate, category: currentCategory });
        }
      });
    }
    node = walker.nextNode();
  }
  return rates;
}

// Same slug construction the extension used when it opened the tab.
function merchantUrl(merchant) {
  const slug = merchant.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  return `https://www.cashbackmonitor.com/cashback-store/${slug}/?vendor=${encodeURIComponent(merchant)}`;
}

// Scrapes portal rates for each merchant. Returns the exact payload shape
// /api/portal-rates/bulk expects, plus a per-merchant result list for the
// command's `result` field (the extension reported the same shape).
async function scrapeCashbackMonitor(page, merchants) {
  const entries = [];
  const results = [];

  for (const merchant of merchants) {
    let rates = [];
    try {
      await page.goto(merchantUrl(merchant), { waitUntil: 'load', timeout: MERCHANT_TIMEOUT_MS });
      // The content script parsed on `load`; give the rate spans (which
      // are populated by CBM's own script after load) a moment more.
      await sleep(1000);
      rates = await page.evaluate(parseTablesInBrowser);
    } catch (e) {
      console.warn(`[cbm] ${merchant}: scrape failed: ${e.message}`);
      results.push({ merchant, rateCount: 0, ok: false });
      await sleep(BETWEEN_MERCHANTS_MS);
      continue;
    }
    console.log(`[cbm] ${merchant}: ${rates.length} rate(s)`);
    if (rates.length > 0) entries.push({ merchant, rates });
    results.push({ merchant, rateCount: rates.length, ok: true });
    await sleep(BETWEEN_MERCHANTS_MS);
  }

  return { entries, results };
}

module.exports = { scrapeCashbackMonitor, merchantUrl };
