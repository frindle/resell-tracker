import test from 'node:test';
import assert from 'node:assert/strict';

import { guessMerchantName, learnMerchant, parseLearnedMerchants, resolveMerchant, senderDomain } from './merchants.ts';

test('sender domain drops subdomains and keeps two-part country endings', () => {
  assert.equal(senderDomain('Best Buy <BestBuyInfo@emailinfo.bestbuy.com>'), 'bestbuy.com');
  assert.equal(senderDomain('orders@shop.example.co.uk'), 'example.co.uk');
  assert.equal(senderDomain('noreply@target.com'), 'target.com');
  assert.equal(senderDomain('Store'), null);
  assert.equal(senderDomain(''), null);
});

test('store name: display name unless it is generic, else the domain', () => {
  assert.equal(guessMerchantName('"Best Buy" <BestBuyInfo@emailinfo.bestbuy.com>'), 'Best Buy');
  assert.equal(guessMerchantName('No-Reply <no-reply@samsclub.com>'), 'Samsclub');
  assert.equal(guessMerchantName('orders@target.com'), 'Target');
  assert.equal(guessMerchantName('Customer Service <cs@bhphotovideo.com>'), 'Bhphotovideo');
  assert.equal(guessMerchantName(''), 'Other');
});

test('built-in stores stay as they are', () => {
  assert.deepEqual(resolveMerchant('Amazon', 'auto-confirm@amazon.com', []), { platform: 'Amazon', known: true, domain: 'amazon.com' });
});

test('an unknown sender is new until a person confirms it, then imports under its name', () => {
  const from = 'Best Buy <BestBuyInfo@emailinfo.bestbuy.com>';
  assert.deepEqual(resolveMerchant('Unknown', from, []), { platform: 'Best Buy', known: false, domain: 'bestbuy.com' });
  const learned = learnMerchant([], 'bestbuy.com', 'BestBuy');
  assert.deepEqual(resolveMerchant('Unknown', from, learned), { platform: 'BestBuy', known: true, domain: 'bestbuy.com' });
  // Another sender address at the same store counts too.
  assert.equal(resolveMerchant('Unknown', 'orders@bestbuy.com', learned).known, true);
});

test('learning keeps one entry per domain and ignores blanks and "Other"', () => {
  let list = learnMerchant([], 'BestBuy.com', ' Best  Buy ');
  list = learnMerchant(list, 'bestbuy.com', 'Best Buy US');
  assert.deepEqual(list, [{ domain: 'bestbuy.com', name: 'Best Buy US' }]);
  assert.deepEqual(learnMerchant(list, 'target.com', 'other'), list);
  assert.deepEqual(learnMerchant(list, '', 'Target'), list);
});

test('stored list: bad JSON or bad rows are dropped', () => {
  assert.deepEqual(parseLearnedMerchants('nope'), []);
  assert.deepEqual(parseLearnedMerchants(null), []);
  assert.deepEqual(parseLearnedMerchants('[{"domain":"Target.com","name":"Target"},{"domain":"x.com"},{"name":"y"}]'), [{ domain: 'target.com', name: 'Target' }]);
});
