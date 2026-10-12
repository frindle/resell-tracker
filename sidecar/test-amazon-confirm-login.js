'use strict';
// Regression test: Amazon confirmLoggedIn must not treat any /ap/ (sign-in flow)
// page as logged in, and must return false when url() throws or evaluate rejects.

const assert = require('assert');
process.env.TRACKER_URL = process.env.TRACKER_URL || 'http://127.0.0.1:9';
process.env.TRACKER_USER_ID = process.env.TRACKER_USER_ID || '1';
const { confirmLoggedIn, isLoggedOut } = require('./src/amazon');

// Stub document: counts per signal.
function page(url, { orders = 0, signout = 0, nav = null } = {}) {
  return {
    url: () => url,
    evaluate: async fn => {
      global.document = {
        querySelectorAll: sel => {
          if (/orderID|order-details|orderGroup/.test(sel)) return new Array(orders);
          if (/signout|sign-out/.test(sel)) return new Array(signout);
          return [];
        },
        querySelector: () => (nav === null ? null : { textContent: nav }),
      };
      try { return fn(); } finally { delete global.document; }
    },
  };
}

(async () => {
  const t = async (url, opts, want, why) => assert.strictEqual(await confirmLoggedIn(page(url, opts)), want, why + ' [' + url + ']');

  // the bug: a bare sign-out link (or nav text) on the sign-in flow pages
  await t('https://www.amazon.com/ap/signin?openid.return_to=x', { signout: 1 }, false, '/ap/signin + sign out link');
  await t('https://www.amazon.com/ap/switchaccount', { signout: 1 }, false, '/ap/switchaccount (not matched by isLoggedOut) + sign out link');
  await t('https://www.amazon.com/ap/mfa', { nav: 'Hello, Penn' }, false, '/ap/mfa + signed-in-looking nav');
  await t('https://www.amazon.com/ap/challenge', { orders: 3, signout: 1 }, false, '/ap/challenge even with order-looking links');
  await t('https://www.amazon.com/ap/cvf/request', { signout: 1 }, false, '/ap/cvf');
  assert.strictEqual(isLoggedOut(page('https://www.amazon.com/ap/switchaccount')), false, 'isLoggedOut unchanged (only signin|cvf)');
  assert.strictEqual(isLoggedOut(page('https://www.amazon.com/ap/signin')), true, 'isLoggedOut unchanged for /ap/signin');

  // real logged-in signals outside /ap/ keep working (no regression of the old signals)
  await t('https://www.amazon.com/your-orders/orders', { orders: 4 }, true, 'order cards');
  await t('https://www.amazon.com/your-orders/orders', { nav: 'Hello, Penn' }, true, 'signed-in nav');
  await t('https://www.amazon.com/gp/css/homepage.html', { signout: 1 }, true, 'sign out link on a normal page');
  await t('https://www.amazon.com/your-orders/orders', { nav: 'Hello, sign in' }, false, 'nav says sign in');
  await t('https://www.amazon.com/your-orders/orders', {}, false, 'nothing');
  await t('https://www.amazon.com/your-orders/orders?returnTo=/ap/signin', { orders: 2 }, true, '/ap/ only in the query string must not matter');
  await t('https://www.amazon.com/gp/aws/apply/foo', { signout: 1 }, true, '/ap prefix of a different path segment must not match');

  // robustness: url() throwing or evaluate rejecting -> false, no throw
  assert.strictEqual(await confirmLoggedIn({ url: () => { throw new Error('closed'); }, evaluate: async () => true }), false, 'url() throws -> false');
  assert.strictEqual(await confirmLoggedIn({ url: () => 'https://www.amazon.com/your-orders/orders', evaluate: async () => { throw new Error('nav'); } }), false, 'evaluate rejects -> false');

  console.log('test-amazon-confirm-login: ok');
})().catch(e => { console.error(e); process.exit(1); });
