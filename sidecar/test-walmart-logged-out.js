'use strict';
// Nov 2026: a dead Walmart session on /orders renders the guest "Track your
// order" page instead of bouncing to /account/login. isLoggedOut must call
// that logged out, so sync throws SessionExpiredError, the tracker marks the
// session expired, and the login queue opens the login page on VNC.
process.env.TRACKER_URL = process.env.TRACKER_URL || 'http://localhost:9';
process.env.TRACKER_USER_ID = process.env.TRACKER_USER_ID || '1';
const test = require('node:test');
const assert = require('node:assert/strict');

const libPath = require.resolve('./src/lib.js', { paths: [__dirname] });
class SessionExpiredError extends Error {}
require.cache[libPath] = {
  id: libPath, filename: libPath, loaded: true,
  exports: { SessionExpiredError, fetchLockedOrderNumbers: async () => new Set(), captureFailure: async () => ({}) },
};
const { isLoggedOut, loggedOutFromSignals } = require('./src/walmart.js');

const GUEST = { title: 'Manage Account - Track your order - Walmart.com', path: '/orders', signInButton: true };
const SIGNED_IN = { title: 'Manage Account - Purchase history - Walmart.com', path: '/orders', signInButton: false };

test('guest "Track your order" page is logged out; signed-in purchase history is not', () => {
  assert.equal(loggedOutFromSignals(GUEST), true);
  assert.equal(loggedOutFromSignals({ ...GUEST, signInButton: false }), true, 'title alone is enough on /orders');
  assert.equal(loggedOutFromSignals({ title: 'Walmart.com', path: '/', signInButton: true }), true, 'header sign-in button alone');
  assert.equal(loggedOutFromSignals(SIGNED_IN), false);
  assert.equal(loggedOutFromSignals({ title: 'Login | Walmart', path: '/x' }), true);
  assert.equal(loggedOutFromSignals({}), false);
});

function fakePage(signals, html = '<html><title>Orders</title><a href="/account/login">Sign in</a></html>') {
  return {
    url: () => 'https://www.walmart.com/orders',
    content: async () => html,
    evaluate: async (fn) => (fn.name === 'walmartSessionSignalsInBrowser' ? signals : ''),
  };
}

test('isLoggedOut reads the DOM signals and ignores benign sign-in links in the HTML', async () => {
  assert.equal(await isLoggedOut(fakePage(GUEST)), true);
  assert.equal(await isLoggedOut(fakePage(SIGNED_IN)), false);
  assert.equal(await isLoggedOut(fakePage('')), false, 'non-object evaluate result is not a logout');
  assert.equal(await isLoggedOut({ ...fakePage(SIGNED_IN), url: () => 'https://www.walmart.com/account/login?x=1' }), true);
});
