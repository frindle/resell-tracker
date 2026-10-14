// Adversarial fixture for: egiftRedemption (parseRedemptionPage, parameterized per site)
// ALL HTML here is SYNTHETIC, written from the DOM maps of the two InComm portals (Costco, Best Buy);
// no real portal, no real order refs, no real codes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseRedemptionPage } = require('./sidecar/src/costcoEgiftRedemption.js') as {
  parseRedemptionPage: (html: unknown, cfg?: unknown) => any;
};

const COSTCO = { openLabel: 'Access eGift', orderPrefix: null };
const BESTBUY = { openLabel: 'View', orderPrefix: 'BBY01-' };

const send = '<input type="submit" value="Send Gift">';
const access = '<input type="submit" value="Access eGift">';
const view = '<input type="submit" value="View" target="_blank">';
const card = (n: number, m: number, title: string, actions = send + access, sectionAttrs = 'class="order-item"') =>
  `<section ${sectionAttrs}><div class="order-item-image"><img alt="Product Image"></div><div class="order-item-title">${title}</div>` +
  `<span class="order-item-counter">${n} of ${m}</span><div class="order-item-status"></div>` +
  `<div class="order-item-actions">${actions}</div></section>`;
const page = (inner: string, head = '') => `<html><body><form id="j_idt52">${head}${inner}</form></body></html>`;
const bbHead = '<div class="order-summary"><p>Order Number: BBY01-0000123</p><p>Ordered On: 01/02/2026</p></div><section class="fraud-warning"><p>Beware of scams. 1 of 1</p></section>';

test('costco happy path: ordered cards, entity-decoded titles, Send Gift listed first, canOpen true', () => {
  const r = parseRedemptionPage(page(card(1, 3, 'Costco &amp; Friends $25') + card(2, 3, 'Gift B') + card(3, 3, 'Gift C')), COSTCO);
  assert.deepEqual(r, {
    ok: true, orderNumber: null, total: 3,
    cards: [
      { index: 1, title: 'Costco & Friends $25', canOpen: true },
      { index: 2, title: 'Gift B', canOpen: true },
      { index: 3, title: 'Gift C', canOpen: true },
    ],
  });
});

test('bestbuy happy path: View label, order number BBY01-..., fraud-warning section is not a card', () => {
  const r = parseRedemptionPage(page(card(1, 2, 'StubHub $100', send + view) + card(2, 2, 'StubHub $100', send + view), bbHead), BESTBUY);
  assert.deepEqual(r, {
    ok: true, orderNumber: 'BBY01-0000123', total: 2,
    cards: [{ index: 1, title: 'StubHub $100', canOpen: true }, { index: 2, title: 'StubHub $100', canOpen: true }],
  });
});

test('the open label is the SITE config: Access eGift does not open a Best Buy card, View does not open a Costco card', () => {
  assert.deepEqual(parseRedemptionPage(page(card(1, 1, 'T', send + access)), BESTBUY).cards.map((c: any) => c.canOpen), [false]);
  assert.deepEqual(parseRedemptionPage(page(card(1, 1, 'T', send + view)), COSTCO).cards.map((c: any) => c.canOpen), [false]);
});

test('orderPrefix: a number without the site prefix is not accepted; no prefix configured accepts any; absent -> null', () => {
  const c = card(1, 1, 'T', send + view);
  assert.equal(parseRedemptionPage(page(c, '<p>Order Number: 9990001</p>'), BESTBUY).orderNumber, null);
  assert.equal(parseRedemptionPage(page(c, '<p>Order Number: 9990001</p>'), { openLabel: 'View', orderPrefix: null }).orderNumber, '9990001');
  assert.equal(parseRedemptionPage(page(c), BESTBUY).orderNumber, null);
});

test('over-trigger: a Send-Gift-only card cannot be opened, even when its TITLE contains the open label', () => {
  const r = parseRedemptionPage(page(card(1, 2, 'Access eGift Promo Card', send) + card(2, 2, 'Plain', access)), COSTCO);
  assert.deepEqual(r.cards.map((c: any) => c.canOpen), [false, true]);
  const b = parseRedemptionPage(page(card(1, 2, 'View Deal', send) + card(2, 2, 'Plain', view)), BESTBUY);
  assert.deepEqual(b.cards.map((c: any) => c.canOpen), [false, true]);
});

test('a control OUTSIDE .order-item-actions does not count; a longer label (Preview, View Terms) is not View', () => {
  const html = page(
    '<section class="order-item"><div class="order-item-title">T</div><a href="#">View</a>' +
      '<span>1 of 1</span><div class="order-item-actions">' + send + '<button>Preview</button><a>View Terms</a></div></section>');
  assert.equal(parseRedemptionPage(html, BESTBUY).cards[0].canOpen, false);
});

test('button and anchor controls count; label is trimmed and case-insensitive; Send Gift never does', () => {
  const r = parseRedemptionPage(page(
    card(1, 3, 'A', '<button type="submit"><span class="ui-button-text">  ACCESS eGift </span></button>') +
    card(2, 3, 'B', '<a class="x">Access eGift</a><input type="submit" value="Send Gift">') +
    card(3, 3, 'C', '<button>Send Gift</button>')), COSTCO);
  assert.deepEqual(r.cards.map((c: any) => c.canOpen), [true, true, false]);
});

test('class matching is by whole token: lookalike sections and commented/script markup are not cards', () => {
  const html = page(
    '<section class="reorder-item"><span>1 of 9</span></section>' +
    '<section class="order-item-extra"><span>1 of 9</span></section>' +
    '<!-- <section class="order-item"><div class="order-item-title">GHOST</div></section> -->' +
    '<script>var s = \'<section class="order-item"><div class="order-item-title">GHOST2</div></section>\';</script>' +
    card(1, 1, 'Real', access, 'class="foo order-item bar"'));
  const r = parseRedemptionPage(html, COSTCO);
  assert.equal(r.cards.length, 1);
  assert.equal(r.cards[0].title, 'Real');
});

test('counter is read OUTSIDE the title: a title that looks like a counter does not win', () => {
  const r = parseRedemptionPage(page(card(2, 3, 'Deal 7 of 9 special') + card(1, 3, 'X')), COSTCO);
  assert.deepEqual(r.cards.map((c: any) => [c.index, c.title]), [[2, 'Deal 7 of 9 special'], [1, 'X']]);
  assert.equal(r.total, 3);
});

test('tag attributes containing > and a nested <section> do not truncate or split a card', () => {
  const html = page(
    '<section class="order-item" data-x="a>b"><div class="order-item-title">Nest</div>' +
    '<section class="details"><p>fine print</p></section><span>1 of 1</span>' +
    '<div class="order-item-actions">' + access + '</div></section>');
  assert.deepEqual(parseRedemptionPage(html, COSTCO), { ok: true, orderNumber: null, total: 1, cards: [{ index: 1, title: 'Nest', canOpen: true }] });
});

test('a card with no counter falls back to its 1-based position; total falls back to the card count', () => {
  const bare = (t: string) => `<section class="order-item"><div class="order-item-title">${t}</div><div class="order-item-actions">${access}</div></section>`;
  const r = parseRedemptionPage(page(bare('P') + bare('Q')), COSTCO);
  assert.deepEqual(r, { ok: true, orderNumber: null, total: 2, cards: [
    { index: 1, title: 'P', canOpen: true }, { index: 2, title: 'Q', canOpen: true }] });
});

test('no cards: an alert page reports alert, a blank page reports no-cards', () => {
  const alertHtml = '<form id="find-order-form"><div class="ui-message ui-message-error" role="alert">Email does not match</div></form>';
  assert.deepEqual(parseRedemptionPage(alertHtml, COSTCO), { ok: false, reason: 'alert' });
  assert.deepEqual(parseRedemptionPage('<div class="ui-message" role="alert">  </div>', BESTBUY), { ok: false, reason: 'no-cards' });
  assert.deepEqual(parseRedemptionPage(page(''), COSTCO), { ok: false, reason: 'no-cards' });
});

test('invalid input never throws: non-string html, or a missing/malformed site config', () => {
  for (const bad of [null, undefined, 42, {}, ['x']]) {
    assert.deepEqual(parseRedemptionPage(bad, COSTCO), { ok: false, reason: 'invalid-input' });
  }
  for (const cfg of [undefined, null, {}, { openLabel: 5 }]) {
    assert.deepEqual(parseRedemptionPage(page(card(1, 1, 'T')), cfg), { ok: false, reason: 'invalid-input' });
  }
});

test('failure results never echo the input html', () => {
  const marker = 'MARKER-' + 'ZZ123';
  const r = parseRedemptionPage('<div class="ui-message" role="alert">' + marker + '</div>', COSTCO);
  assert.equal(r.ok, false);
  assert.ok(!JSON.stringify(r).includes(marker));
});
