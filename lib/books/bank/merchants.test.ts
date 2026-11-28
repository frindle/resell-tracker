import { test } from 'node:test';
import assert from 'node:assert/strict';
import { merchantGroupKey, groupMerchants, type MerchantTxn } from './merchants.ts';
import type { MatchRuleIn } from '../match.ts';

test('processor prefixes, digits, store numbers and state tails are stripped', () => {
  assert.equal(merchantGroupKey('SQ *SHOP 123 SEATTLE WA').key, 'shop');
  assert.equal(merchantGroupKey('TST* CAFE LUNA #4412').key, 'cafe luna');
  assert.equal(merchantGroupKey('PAYPAL *SPOTIFY 4029357733').key, 'spotify');
  assert.equal(merchantGroupKey('SHELL OIL 57444 SPRINGFIELD IL').key, 'shell oil');
  assert.equal(merchantGroupKey('NETFLIX.COM').key, 'netflix');
});

test('known retailers keep their retailer key and a pattern the description contains', () => {
  assert.equal(merchantGroupKey('AMZN MKTP US*2K4AB1').key, 'amazon');
  assert.equal(merchantGroupKey('AMZN MKTP US*2K4AB1').pattern, 'amzn');
  assert.equal(merchantGroupKey('WAL-MART #1234').key, 'walmart');
  assert.equal(merchantGroupKey('BESTBUY 00012').key, 'best buy');
});

test('the pattern is always a substring of the description (rules match by substring)', () => {
  for (const d of ['SQ *JOES-PIZZA 55', 'TARGET T-1234', 'CHECKCARD 0101 ACME HARDWARE GA', 'Some Shop - Online', 'NETFLIX.COM']) {
    const { pattern } = merchantGroupKey(d);
    assert.ok(d.toLowerCase().includes(pattern), `${d} -> ${pattern}`);
  }
});

const t = (id: number, accountId: number, postedDate: string, amountCents: number, description: string): MerchantTxn => ({ id, accountId, postedDate, amountCents, description });
const accts = [{ id: 1, name: 'Card', mapped: false }, { id: 2, name: 'Checking', mapped: true }];

test('groups debits by merchant: totals, dates, accounts, samples, largest first; credits are skipped', () => {
  const rows = [
    t(1, 1, '2026-01-05', -1000, 'SQ *SHOP'), t(2, 1, '2026-02-09', -500, 'SQ *SHOP'), t(3, 2, '2026-01-20', -250, 'SQ *SHOP'),
    t(4, 1, '2026-01-02', -5000, 'TST* CAFE'), t(5, 1, '2026-01-03', 900, 'SQ *SHOP'),
    t(6, 1, '2026-01-06', -100, 'SQ *SHOP 1'), t(7, 1, '2026-01-07', -100, 'SQ *SHOP 2'),
  ];
  const g = groupMerchants(rows, accts, []);
  assert.deepEqual(g.map(x => x.key), ['cafe', 'shop']);
  const shop = g[1];
  assert.equal(shop.count, 5);
  assert.equal(shop.totalCents, 1950);
  assert.equal(shop.firstDate, '2026-01-05');
  assert.equal(shop.lastDate, '2026-02-09');
  assert.deepEqual(shop.accounts, [{ id: 1, name: 'Card' }, { id: 2, name: 'Checking' }]);
  assert.deepEqual(shop.samples, ['SQ *SHOP', 'SQ *SHOP 1', 'SQ *SHOP 2']);
  assert.equal(shop.allUnmapped, false);
  assert.equal(g[0].allUnmapped, true);
});

test('ruled is set when an existing rule matches a row (the same matcher the rules pass uses)', () => {
  const rule: MatchRuleIn = { id: 1, bankAccountId: null, pattern: 'cafe', isRegex: false, sign: 'debit', minCents: null, maxCents: null, action: 'personal', enabled: true };
  const g = groupMerchants([t(1, 1, '2026-01-02', -500, 'TST* CAFE'), t(2, 1, '2026-01-03', -500, 'HARDWARE CO')], accts, [rule]);
  assert.equal(g.find(x => x.key === 'cafe')!.ruled, true);
  assert.equal(g.find(x => x.key === 'hardware')!.ruled, false);
  assert.equal(groupMerchants([t(1, 1, '2026-01-02', -500, 'TST* CAFE')], accts, [{ ...rule, enabled: false }])[0].ruled, false);
});
