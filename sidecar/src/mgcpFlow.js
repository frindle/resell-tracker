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
// them in a returned reason. Only counts and error codes leave it.

module.exports = { runMgcpCapture, parseTitle, parseCardNumber, parsePin, makePlaywrightDriver };

const CLICK_TEXT = /click here to use your gift card/i;

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

async function runMgcpCapture({
  driver, links, save, markFailed = async () => {}, onCaptcha = async () => {},
  sleep = realSleep, now = Date.now, log = () => {},
  delayMs = 4000, pollMs = 1000, readyTimeoutMs = 45000, captchaTimeoutMs = 15 * 60 * 1000,
} = {}) {
  const out = { saved: 0, failed: 0, total: links ? links.length : 0, stopped: null };
  if (!driver || !Array.isArray(links) || typeof save !== 'function') return { ...out, stopped: 'invalid-input' };

  for (let i = 0; i < links.length; i++) {
    const { id, link } = links[i];
    let reason = null;
    try {
      if (i > 0) await sleep(delayMs);
      log(`link ${i + 1}/${links.length}: opening`);
      const landing = await driver.open(link);
      const meta = parseTitle(landing && landing.title);

      let state = 'unknown';
      let captchaSince = null;
      let started = now();
      let clicked = false;
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
          if (state === 'landing' && !clicked) { await driver.clickUse(); clicked = true; started = now(); }
          else if (state === 'landing') clicked = false; // click didn't take; retry next tick
          if (now() - started > readyTimeoutMs) { reason = 'card-not-ready'; break; }
        }
        await sleep(pollMs);
      }
      if (captchaSince != null) await onCaptcha(false);
      if (reason) throw Object.assign(new Error(reason), { code: reason });

      const card = await driver.readCard();
      const cardNumber = parseCardNumber(card && card.cardNumber);
      if (!cardNumber) throw Object.assign(new Error('no-card-number'), { code: 'no-card-number' });
      if (!meta) throw Object.assign(new Error('title-unparsed'), { code: 'title-unparsed' });
      const pdf = await driver.capturePdf();
      const barcode = await driver.captureBarcode();

      await save({ linkId: id, merchant: meta.merchant, value: meta.value, cardNumber, pin: parsePin(card.pin), pdf, barcode });
      out.saved++;
      log(`link ${i + 1}/${links.length}: saved`);
    } catch (e) {
      reason = e && e.code ? e.code : 'driver-error';
      out.failed++;
      log(`link ${i + 1}/${links.length}: failed (${reason})`);
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
  // The card may open in a popup / same tab; always follow the newest page.
  async function current() {
    const pages = context.pages().filter(p => !p.isClosed());
    page = pages[pages.length - 1] || page;
    return page;
  }

  return {
    async open(link) {
      const p = await pageFor();
      await p.goto(link, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await p.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      return { title: await p.title().catch(() => '') };
    },
    async state() {
      const p = await current();
      if (await p.locator(cardNumberSel).count().catch(() => 0)) return 'card';
      if (await p.locator('iframe#main-iframe').count().catch(() => 0)) return 'captcha';
      const body = await p.locator('body').innerText({ timeout: 2000 }).catch(() => '');
      if (/complete this quick check|incapsula|imperva/i.test(body)) return 'captcha';
      if (await p.getByText(CLICK_TEXT).count().catch(() => 0)) return 'landing';
      return 'unknown';
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
