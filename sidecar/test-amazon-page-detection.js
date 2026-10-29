'use strict';
// Frozen acceptance test: scrapeYear (sidecar/src/amazon.js) must classify the pages Amazon serves at the
// your-orders URL without a redirect. Detection only; nothing here clicks or retries anything.
const test = require('node:test');
const assert = require('assert');
const fs = require('fs');
const path = require('path');

process.env.TRACKER_URL = 'http://127.0.0.1:9';
process.env.TRACKER_USER_ID = '1';

try { require.resolve('playwright-core'); } catch (_) {
  const Module = require('module');
  const origLoad = Module._load;
  Module._load = function (request, ...rest) {
    if (request === 'playwright-core') return { chromium: {} };
    return origLoad.call(this, request, ...rest);
  };
}

const lib = require('./src/lib');
const amazon = require('./src/amazon');
const { SessionExpiredError, AmazonBlockedError } = lib;
const ORDERS_URL = 'https://www.amazon.com/your-orders/orders';

const fx = n => fs.readFileSync(path.join(__dirname, 'fixtures', 'amazon', n), 'utf8');

// ---- tiny fake DOM over an HTML string (no jsdom in this checkout) ----
function parseTags(html) {
  const out = [];
  const re = /<([a-zA-Z][\w-]*)\b([^>]*)>/g;
  let m;
  while ((m = re.exec(html))) {
    const attrs = {};
    const are = /([\w:-]+)(?:\s*=\s*"([^"]*)")?/g;
    let a;
    while ((a = are.exec(m[2]))) attrs[a[1]] = a[2] === undefined ? '' : a[2];
    out.push({ tag: m[1].toLowerCase(), attrs, end: m.index + m[0].length });
  }
  return out;
}
function textOf(html) {
  return html
    .replace(/<(script|style|head)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ').trim();
}
function matchCompound(el, sel) {
  const mt = sel.match(/^([a-zA-Z][\w-]*)?/);
  if (mt[1] && mt[1].toLowerCase() !== el.tag) return false;
  let rest = sel.slice(mt[0].length);
  while (rest) {
    let m;
    if ((m = rest.match(/^#([\w-]+)/))) { if (el.attrs.id !== m[1]) return false; }
    else if ((m = rest.match(/^\.([\w-]+)/))) { if (!(el.attrs.class || '').split(/\s+/).includes(m[1])) return false; }
    else if ((m = rest.match(/^\[([\w:-]+)(?:([*^$]?=)"([^"]*)")?\]/))) {
      const v = el.attrs[m[1]];
      if (v === undefined) return false;
      if (m[2] === '=' && v !== m[3]) return false;
      if (m[2] === '*=' && !v.includes(m[3])) return false;
      if (m[2] === '^=' && !v.startsWith(m[3])) return false;
      if (m[2] === '$=' && !v.endsWith(m[3])) return false;
    } else throw new Error('fake DOM: unsupported selector ' + sel);
    rest = rest.slice(m[0].length);
  }
  return true;
}
function makeDom(html, url) {
  const tags = parseTags(html);
  const wrap = el => ({
    ...el,
    get textContent() {
      const close = html.toLowerCase().indexOf('</' + el.tag, el.end);
      return textOf(html.slice(el.end, close < 0 ? html.length : close));
    },
    getAttribute: k => (el.attrs[k] === undefined ? null : el.attrs[k]),
    href: el.attrs.href,
  });
  const all = sel => sel.split(',').map(s => s.trim()).flatMap(s => tags.filter(t => matchCompound(t, s)).map(wrap));
  const text = textOf(html);
  return {
    location: { href: url },
    document: {
      title: (html.match(/<title[^>]*>([^<]*)<\/title>/i) || [, ''])[1],
      body: { innerText: text, textContent: text },
      querySelector: sel => all(sel)[0] || null,
      querySelectorAll: sel => all(sel),
    },
  };
}
function fakePage(html) {
  const dom = makeDom(html, ORDERS_URL);
  return {
    goto: async () => {},
    url: () => ORDERS_URL,
    evaluate: async (fn, arg) => {
      if (fn.name === 'waitForOrdersInBrowser') return true;
      if (fn.name === 'scrapeDocInBrowser') {
        const n = (html.match(/order-details\?orderID=/g) || []).length;
        return { orders: [], sawOlder: false, anyInWindow: false, linkCount: n };
      }
      if (fn.name === 'getNextStartIndexInBrowser') return null;
      const prevDoc = global.document; const prevLoc = global.location;
      global.document = dom.document; global.location = dom.location;
      try { return fn(arg); } finally { global.document = prevDoc; global.location = prevLoc; }
    },
  };
}
const run = html => amazon.scrapeYear(fakePage(html), null, '2026-01-01', [], new Set());

test('the sign-in page served at the your-orders URL throws SessionExpiredError', async () => {
  await assert.rejects(run(fx('signin-page.html')), err => {
    assert.ok(err instanceof SessionExpiredError, 'expected SessionExpiredError, got ' + err);
    assert.ok(!(err instanceof AmazonBlockedError));
    return true;
  });
});

test('the bot-check interstitial throws AmazonBlockedError, distinct from sign-in expiry and from 0 cards', async () => {
  await assert.rejects(run(fx('bot-block.html')), err => {
    assert.ok(err instanceof AmazonBlockedError, 'expected AmazonBlockedError, got ' + err);
    assert.ok(!(err instanceof SessionExpiredError));
    assert.strictEqual(err.name, 'AmazonBlockedError');
    assert.ok(!/0 order cards/.test(err.message));
    return true;
  });
});

test('a normal orders page and a genuinely empty year do not throw', async () => {
  await run(fx('orders-normal.html'));
  await run(fx('orders-empty-year.html'));
});

test('unrecognised blank pages keep the generic 0-cards error and a signed-out nav still means session expired', async () => {
  await assert.rejects(run('<html><head><title>Amazon.com</title></head><body><p>Something unexpected</p></body></html>'), err => {
    assert.ok(!(err instanceof SessionExpiredError) && !(err instanceof AmazonBlockedError));
    assert.match(err.message, /0 order cards/);
    return true;
  });
  const nav = '<html><head><title>Amazon.com</title></head><body><a id="nav-link-accountList"><span id="nav-link-accountList-nav-line-1">Hello, sign in</span></a></body></html>';
  await assert.rejects(run(nav), err => err instanceof SessionExpiredError);
});
