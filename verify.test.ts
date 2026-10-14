// Adversarial fixture for: egiftRedemption (parseRedemptionPage)
// ALL HTML here is SYNTHETIC, written from the DOM map; no real portal, no real codes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseRedemptionPage } = require('./sidecar/src/costcoEgiftRedemption.js') as {
  parseRedemptionPage: (html: unknown) => any;
};

const send = '<input type="submit" value="Send Gift">';
const access = '<input type="submit" value="Access eGift">';
const card = (n: number, m: number, title: string, actions = send + access, sectionAttrs = 'class="order-item"') =>
  `<section ${sectionAttrs}><div class="order-item-title">${title}</div><span class="order-item-counter">${n} of ${m}</span>` +
  `<div class="order-item-actions">${actions}</div></section>`;
const page = (inner: string) => `<html><body><form id="j_idt52">${inner}</form></body></html>`;

test('happy path: ordered cards, entity-decoded titles, Send Gift listed first, hasAccess true', () => {
  const r = parseRedemptionPage(page(card(1, 3, 'Costco &amp; Friends $25') + card(2, 3, 'Gift B') + card(3, 3, 'Gift C')));
  assert.deepEqual(r, {
    ok: true, total: 3,
    cards: [
      { index: 1, title: 'Costco & Friends $25', hasAccess: true },
      { index: 2, title: 'Gift B', hasAccess: true },
      { index: 3, title: 'Gift C', hasAccess: true },
    ],
  });
});

test('over-trigger: a Send-Gift-only card is NOT accessible, even when its TITLE says Access eGift', () => {
  const r = parseRedemptionPage(page(card(1, 2, 'Access eGift Promo Card', send) + card(2, 2, 'Plain', access)));
  assert.deepEqual(r.cards.map((c: any) => c.hasAccess), [false, true]);
});

test('an Access eGift control OUTSIDE .order-item-actions does not count', () => {
  const html = page(
    '<section class="order-item"><div class="order-item-title">T</div><a href="#">Access eGift</a>' +
      '<span>1 of 1</span><div class="order-item-actions">' + send + '</div></section>');
  assert.equal(parseRedemptionPage(html).cards[0].hasAccess, false);
});

test('button and anchor controls count; label is trimmed and case-insensitive; Send Gift never does', () => {
  const r = parseRedemptionPage(page(
    card(1, 3, 'A', '<button type="submit"><span class="ui-button-text">  ACCESS eGift </span></button>') +
    card(2, 3, 'B', '<a class="x">Access eGift</a><input type="submit" value="Send Gift">') +
    card(3, 3, 'C', '<button>Send Gift</button>')));
  assert.deepEqual(r.cards.map((c: any) => c.hasAccess), [true, true, false]);
});

test('class matching is by whole token: lookalike sections and commented/script markup are not cards', () => {
  const html = page(
    '<section class="reorder-item"><span>1 of 9</span></section>' +
    '<section class="order-item-extra"><span>1 of 9</span></section>' +
    '<!-- <section class="order-item"><div class="order-item-title">GHOST</div></section> -->' +
    '<script>var s = \'<section class="order-item"><div class="order-item-title">GHOST2</div></section>\';</script>' +
    card(1, 1, 'Real', access, 'class="foo order-item bar"'));
  const r = parseRedemptionPage(html);
  assert.equal(r.cards.length, 1);
  assert.equal(r.cards[0].title, 'Real');
});

test('counter is read OUTSIDE the title: a title that looks like a counter does not win', () => {
  const r = parseRedemptionPage(page(card(2, 3, 'Deal 7 of 9 special') + card(1, 3, 'X')));
  assert.deepEqual(r.cards.map((c: any) => [c.index, c.title]), [[2, 'Deal 7 of 9 special'], [1, 'X']]);
  assert.equal(r.total, 3);
});

test('tag attributes containing > and a nested <section> do not truncate or split a card', () => {
  const html = page(
    '<section class="order-item" data-x="a>b"><div class="order-item-title">Nest</div>' +
    '<section class="details"><p>fine print</p></section><span>1 of 1</span>' +
    '<div class="order-item-actions">' + access + '</div></section>');
  const r = parseRedemptionPage(html);
  assert.deepEqual(r, { ok: true, total: 1, cards: [{ index: 1, title: 'Nest', hasAccess: true }] });
});

test('a card with no counter falls back to its 1-based position; total falls back to the card count', () => {
  const bare = (t: string) => `<section class="order-item"><div class="order-item-title">${t}</div><div class="order-item-actions">${access}</div></section>`;
  const r = parseRedemptionPage(page(bare('P') + bare('Q')));
  assert.deepEqual(r, { ok: true, total: 2, cards: [
    { index: 1, title: 'P', hasAccess: true }, { index: 2, title: 'Q', hasAccess: true }] });
});

test('no cards: an alert page reports alert, a blank page reports no-cards, junk input never throws', () => {
  const alertHtml = '<form id="find-order-form"><div class="ui-message ui-message-error" role="alert">Email does not match</div></form>';
  assert.deepEqual(parseRedemptionPage(alertHtml), { ok: false, reason: 'alert' });
  assert.deepEqual(parseRedemptionPage('<div class="ui-message" role="alert">  </div>'), { ok: false, reason: 'no-cards' });
  assert.deepEqual(parseRedemptionPage(page('')), { ok: false, reason: 'no-cards' });
  for (const bad of [null, undefined, 42, {}, ['x']]) {
    assert.deepEqual(parseRedemptionPage(bad), { ok: false, reason: 'invalid-input' });
  }
});

test('failure results never echo the input html', () => {
  const marker = 'MARKER-' + 'ZZ123';
  const r = parseRedemptionPage('<div class="ui-message" role="alert">' + marker + '</div>');
  assert.equal(r.ok, false);
  assert.ok(!JSON.stringify(r).includes(marker));
});
