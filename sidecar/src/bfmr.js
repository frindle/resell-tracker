'use strict';

// BFMR (buyformeretail.com) sidecar support.
//
// BFMR's POST /api/login is reCAPTCHA v3 gated and its API sits behind AWS
// WAF Bot Control, so login happens through the shared manual-VNC flow in
// loginFlow.js (SITE_CONFIG consumes ORDERS_URL + isLoggedOut below).

const ORDERS_URL = 'https://www.bfmr.com/my-tracker';

async function isLoggedOut(page) {
  const url = page.url();
  if (url.includes('/login')) return true;
  try {
    // In-page check: the login form has BOTH an email/username input and a
    // password input. Runs in the browser context, so it must be self-
    // contained (no Node-side closures).
    const hasLoginForm = await page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('input'));
      const userField = inputs.some(i => i.type === 'email' || /user|email/i.test(i.name) || /user|email/i.test(i.id));
      const passwordField = inputs.some(i => i.type === 'password');
      return userField && passwordField;
    });
    return hasLoginForm;
  } catch {
    // Page navigated/closed mid-check: fail safe to "not logged out" rather
    // than throwing into loginFlow's polling loop.
    return false;
  }
}

// Proof that a manual-VNC login actually produced a working session: the
// interceptor stashed on window.__bfmrCaptured must contain at least one
// bfmr.com/api/my-tracker response with status 200 and the real grid shape.
async function confirmLoggedIn(page) {
  try {
    return await page.evaluate(() => {
      const captured = window.__bfmrCaptured;
      if (!Array.isArray(captured)) return false;
      for (const entry of captured) {
        const body = entry && entry.body;
        if (entry.status === 200 && body && body.data && Array.isArray(body.data.my_tracker)) return true;
      }
      return false;
    });
  } catch {
    // Page navigated/closed mid-check: fail safe to "not proven" rather than
    // throwing into loginFlow's polling loop.
    return false;
  }
}

module.exports = { ORDERS_URL, isLoggedOut, confirmLoggedIn };
