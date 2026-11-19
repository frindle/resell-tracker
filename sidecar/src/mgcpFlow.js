'use strict';
// MyGiftCardsPlus (MGCP) card capture. One link opens ONE card:
//   mygiftcardsplus.com/card?c=… -> pickup.cardago.com (title "Merchant - $100 Gift Card")
//   -> click "CLICK HERE TO USE YOUR GIFT CARD" -> vcdelivery.com card page
//      (number, PIN, barcode). That last hop is sometimes fronted by an
//      Imperva/Incapsula captcha.
//
// The captcha is NEVER solved or bypassed here. When it appears the flow just
// reports it (onCaptcha) and keeps polling while a person clears it in the
// sidecar's visible browser (VNC); it resumes by itself. Past captchaTimeoutMs
// the whole run stops (remaining links stay pending for the next run).
//
// Card numbers / PINs / links are secrets: nothing in this module logs or puts
// them in a returned reason. Only counts, error codes, the step that failed,
// tab host names and fixed hint words leave it.

module.exports = { runMgcpCapture, parseTitle, parseCardNumber, parsePin, makePlaywrightDriver, hintsFor };

const CLICK_TEXT = /click here to use your gift card/i;
const STATES = ['unknown', 'landing', 'captcha', 'card'];
const RANK = Object.fromEntries(STATES.map((s, i) => [s, i]));

function parseTitle(title) {
  const m = /^\s*(.+?)\s+-\s+\$?\s*([\d,]+(?:\.\d{1,2})?)\s*(?:e-?)?gift\s*card/i.exec(title || '');
  if (!m) return null;
  const value = Number(m[2].replace(/,/g, ''));
  return Number.isFinite(value) && value > 0 ? { merchant: m[1].trim(), value } : null;
}

function parseCardNumber(text) {
  const v = String(text || '').replace(/gift\s*card\s*number\s*:?/i, '').replace(/\s+/g, '');
  return v || null;
}

function parsePin(text) {
  const v = String(text || '').replace(/^\s*pin\s*:?/i, '').replace(/\s+/g, '');
  return v || null;
}

const realSleep = ms => new Promise(r => setTimeout(r, ms));

// Fixed words only: what kind of page a stuck link sat on, never its text.
const STUCK_HINTS = [
  ['verify', /verif(y|ication)|security code|one[- ]time (code|passcode)|code (was )?sent/i],
  ['expired', /expired|no longer (valid|available)|already (been )?(redeemed|claimed|used)|invalid (link|card)/i],
  ['blocked', /access denied|request (unsuccessful|blocked)|unusual (traffic|activity)|are you a robot|forbidden/i],
  ['card-words', /card number|\bpin\b/i],
];
function hintsFor(text) {
  return STUCK_HINTS.filter(([, re]) => re.test(text || '')).map(([name]) => name);
}

// " tabs=host(hint,hint) host" for every open tab, oldest first.
async function describeStuck(driver) {
  if (typeof driver.describe !== 'function') return '';
  try {
    const tabs = ((await driver.describe()) || []).slice(0, 5).map(t => {
      const host = /^[a-z0-9.-]{1,100}$/i.test((t && t.host) || '') ? t.host : (t && t.host ? 'other' : 'blank');
      const hints = Array.isArray(t && t.hints) ? t.hints.filter(h => STUCK_HINTS.some(([n]) => n === h)) : [];
      return hints.length ? `${host}(${hints.join(',')})` : host;
    });
    return ` tabs=${tabs.join(' ') || 'none'}`;
  } catch (_) {
    return '';
  }
}

async function runMgcpCapture({
  driver, links, save, markFailed = async () => {}, onCaptcha = async () => {},
  sleep = realSleep, now = Date.now, log = () => {},
  delayMs = 4000, pollMs = 1000, readyTimeoutMs = 45000, captchaTimeoutMs = 15 * 60 * 1000,
  maxClicks = 3, reclickMs = 8000,
} = {}) {
  const out = { saved: 0, failed: 0, total: links ? links.length : 0, stopped: null };
  if (!driver || !Array.isArray(links) || typeof save !== 'function') return { ...out, stopped: 'invalid-input' };

  for (let i = 0; i < links.length; i++) {
    const { id, link } = links[i];
    let reason = null;
    let step = 'open';
    try {
      if (i > 0) await sleep(delayMs);
      log(`link ${i + 1}/${links.length}: opening`);
      const landing = await driver.open(link);
      step = 'wait';
      const meta = parseTitle(landing && landing.title);

      let state = 'unknown';
      let captchaSince = null;
      // The ready clock runs from the open (or from a cleared captcha) and is
      // never pushed back by a click: a landing page that ignores the click
      // used to re-click and reset it every other tick, so the run never
      // ended and held the browser lock.
      let started = now();
      let clicks = 0;
      let lastClickAt = null;
      for (;;) {
        state = await driver.state();
        if (state === 'card') break;
        if (state === 'captcha') {
          if (captchaSince == null) { captchaSince = now(); await onCaptcha(true); log('captcha: waiting for a person'); }
          if (now() - captchaSince > captchaTimeoutMs) {
            await onCaptcha(false);
            return { ...out, stopped: 'captcha-timeout' };
          }
        } else {
          if (captchaSince != null) { captchaSince = null; started = now(); await onCaptcha(false); log('captcha: cleared'); }
          if (state === 'landing' && clicks < maxClicks && (lastClickAt == null || now() - lastClickAt >= reclickMs)) {
            await driver.clickUse();
            clicks++;
            lastClickAt = now();
          }
          if (now() - started > readyTimeoutMs) { reason = 'card-not-ready'; break; }
        }
        await sleep(pollMs);
      }
      if (captchaSince != null) await onCaptcha(false);
      if (reason) {
        // Where it stopped, with no secrets: each open tab's host name and
        // fixed hint words. Never the link, a URL path or query, or page text.
        const where = await describeStuck(driver);
        const detail = `last=${state} clicks=${clicks}${where}`;
        throw Object.assign(new Error(reason), { code: reason, detail });
      }

      step = 'read';
      const card = await driver.readCard();
      const cardNumber = parseCardNumber(card && card.cardNumber);
      if (!cardNumber) throw Object.assign(new Error('no-card-number'), { code: 'no-card-number' });
      if (!meta) throw Object.assign(new Error('title-unparsed'), { code: 'title-unparsed' });
      const pdf = await driver.capturePdf();
      const barcode = await driver.captureBarcode();

      step = 'save';
      await save({ linkId: id, merchant: meta.merchant, value: meta.value, cardNumber, pin: parsePin(card.pin), pdf, barcode });
      out.saved++;
      log(`link ${i + 1}/${links.length}: saved`);
    } catch (e) {
      reason = e && e.code ? e.code : 'driver-error';
      out.failed++;
      // A driver error's message can quote the URL (the link token), so only
      // its class name is kept, never the message.
      const detail = e && e.detail ? `; ${e.detail}`
        : e && e.code ? ''
        : `; step=${step} err=${/^[A-Za-z]{1,40}$/.test((e && e.name) || '') ? e.name : 'Error'}`;
      (out.failures = out.failures || []).push(`${reason}${detail}`);
      log(`link ${i + 1}/${links.length}: failed (${reason}${detail})`);
      try { await markFailed(id, reason); } catch (_) { /* best effort */ }
    } finally {
      try { await driver.closeTab(); } catch (_) { /* best effort */ }
    }
  }
  return out;
}

// Real Playwright-backed driver. All selectors come from recon of the live pages.
function makePlaywrightDriver(context) {
  let page = null;
  const cardNumberSel = '.gift-card-number > div';

  async function pageFor() {
    if (!page || page.isClosed()) page = await context.newPage();
    return page;
  }
  // The page state() last picked (the most advanced tab), else the newest.
  async function current() {
    if (page && !page.isClosed()) return page;
    const pages = context.pages().filter(p => !p.isClosed());
    page = pages[pages.length - 1] || page;
    return page;
  }
  async function pageState(p) {
    if (await p.locator(cardNumberSel).count().catch(() => 0)) return 'card';
    if (await p.locator('iframe#main-iframe').count().catch(() => 0)) return 'captcha';
    const body = await p.locator('body').innerText({ timeout: 2000 }).catch(() => '');
    if (/complete this quick check|incapsula|imperva/i.test(body)) return 'captcha';
    if (await p.getByText(CLICK_TEXT).count().catch(() => 0)) return 'landing';
    return 'unknown';
  }

  return {
    async open(link) {
      const p = await pageFor();
      await p.goto(link, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await p.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      return { title: await p.title().catch(() => '') };
    },
    // Every open tab is checked, newest first, and the most advanced one is
    // followed: the card can open in a new tab while an older one (or a blank
    // popup) is the newest, which used to read as 'unknown' until timeout.
    async state() {
      const pages = context.pages().filter(p => !p.isClosed()).reverse();
      let best = null;
      let bestRank = -1;
      for (const p of pages) {
        const s = await pageState(p);
        const rank = RANK[s];
        if (rank > bestRank) { best = p; bestRank = rank; }
        if (s === 'card') break;
      }
      if (best) page = best;
      return best ? STATES[bestRank] : 'unknown';
    },
    // Host name and hint words per open tab. The URL's path and query (the
    // link token) and the page text never leave this function.
    async describe() {
      const out = [];
      for (const p of context.pages().filter(x => !x.isClosed())) {
        let host = '';
        try { host = new URL(p.url()).hostname; } catch (_) { /* about:blank etc. */ }
        const body = await p.locator('body').innerText({ timeout: 2000 }).catch(() => '');
        out.push({ host, hints: hintsFor(body) });
      }
      return out;
    },
    async clickUse() {
      const p = await current();
      await p.getByText(CLICK_TEXT).first().click({ timeout: 10000 });
    },
    async readCard() {
      const p = await current();
      const cardNumber = await p.locator(cardNumberSel).first().innerText({ timeout: 5000 }).catch(() => '');
      const pin = await p.locator('div.pin').first().innerText({ timeout: 1500 }).catch(() => '');
      return { cardNumber, pin };
    },
    async capturePdf() {
      // page.pdf() is headless-only and the sidecar's Chrome is headed, so use CDP.
      const p = await current();
      const cdp = await context.newCDPSession(p);
      try {
        const { data } = await cdp.send('Page.printToPDF', { printBackground: true });
        return Buffer.from(data, 'base64');
      } finally { await cdp.detach().catch(() => {}); }
    },
    async captureBarcode() {
      const p = await current();
      const img = p.locator('img[alt="Barcode"]').first();
      if (!(await img.count().catch(() => 0))) return null;
      return img.screenshot({ type: 'png', timeout: 5000 }).catch(() => null);
    },
    async closeTab() {
      for (const p of context.pages()) await p.close().catch(() => {});
      page = null;
    },
  };
}
