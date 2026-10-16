'use strict';
const { test } = require('node:test');
const assert = require('assert');
const mod = require('./src/costcoEgiftRedemption.js');
const CFG = { openLabel: 'Access eGift', orderPrefix: null };
const parse = (h, c) => mod.parseRedemptionPage(h, c || CFG);

const card = (title, actions, extra) =>
  '<section class="order-item">' + (title ? '<div class="order-item-title">' + title + '</div>' : '') +
  (extra || '') + (actions === null ? '' : '<div class="order-item-actions">' + actions + '</div>') + '</section>';
const open = (html, cfg) => parse(html, cfg).cards.map((c) => c.canOpen);

test('button, anchor and input controls match', () => {
  assert.strictEqual(typeof mod.parseRedemptionPage, 'function');
  assert.deepStrictEqual(open(card('', '<button>Access eGift</button>')), [true]);
  assert.deepStrictEqual(open(card('', '<a href="/x">Access eGift</a>')), [true]);
  assert.deepStrictEqual(open(card('', '<input type="submit" value="Access eGift">')), [true]);
});

test('exact equality only', () => {
  assert.strictEqual(typeof mod.parseRedemptionPage, 'function');
  const cfg = { openLabel: 'View', orderPrefix: null };
  assert.deepStrictEqual(open(card('', '<a>View Terms</a>'), cfg), [false]);
  assert.deepStrictEqual(open(card('', '<a>Preview</a>'), cfg), [false]);
  assert.deepStrictEqual(open(card('', '<a>View</a>'), cfg), [true]);
});

test('case and whitespace insensitive', () => {
  assert.strictEqual(typeof mod.parseRedemptionPage, 'function');
  assert.deepStrictEqual(open(card('', '<button>  ACCESS   eGift </button>'), { openLabel: ' access egift ' }), [false]);
  assert.deepStrictEqual(open(card('', '<button>\n ACCESS eGift \n</button>'), { openLabel: ' access egift ' }), [true]);
  assert.deepStrictEqual(open(card('', '<input value=" Access EGIFT ">')), [true]);
});

test('Send Gift never counts', () => {
  assert.strictEqual(typeof mod.parseRedemptionPage, 'function');
  const cfg = { openLabel: 'Send Gift', orderPrefix: null };
  assert.deepStrictEqual(open(card('', '<button>Send Gift</button>'), cfg), [false]);
  assert.deepStrictEqual(open(card('', '<button>Send Gift</button><button>Access eGift</button>')), [true]);
});

test('link outside actions or in title does not count', () => {
  assert.strictEqual(typeof mod.parseRedemptionPage, 'function');
  assert.deepStrictEqual(open(card('', '<button>Other</button>', '<a href="#">Access eGift</a>')), [false]);
  assert.deepStrictEqual(open(card('Access eGift', '<button>Other</button>')), [false]);
  assert.deepStrictEqual(open(card('', null, '<a>Access eGift</a>')), [false]);
});

test('nested elements inside actions, unclosed actions', () => {
  assert.strictEqual(typeof mod.parseRedemptionPage, 'function');
  assert.deepStrictEqual(open(card('', '<div><span><button><b>Access</b> eGift</button></span></div>')), [true]);
  assert.deepStrictEqual(open('<section class="order-item"><div class="order-item-actions"><button>Access eGift</button></section>'), [false]);
});

test('full result with two cards', () => {
  assert.strictEqual(typeof mod.parseRedemptionPage, 'function');
  const html = '<p>Order Number: Q-1</p>' + card('Gift A', '<button>Access eGift</button>', '<p>1 of 2</p>') + card('Gift B', '<button>Send Gift</button>', '<p>2 of 2</p>');
  assert.deepStrictEqual(parse(html), {
    ok: true,
    orderNumber: 'Q-1',
    total: 2,
    cards: [
      { index: 1, title: 'Gift A', canOpen: true },
      { index: 2, title: 'Gift B', canOpen: false },
    ],
  });
});

test('alert result and card keys', () => {
  assert.strictEqual(typeof mod.parseRedemptionPage, 'function');
  assert.deepStrictEqual(parse('<div class="ui-message x" role="alert"> Nothing </div>'), { ok: false, reason: 'alert' });
  assert.deepStrictEqual(Object.keys(parse(card('t', null)).cards[0]), ['index', 'title', 'canOpen']);
});
