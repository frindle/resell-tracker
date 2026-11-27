import test from 'node:test';
import assert from 'node:assert/strict';
import { clickUrlBody, goHref, merchantForHost, parseClickUrl, portalOptions, rateValue, type PortalRateRow } from './portalPicker.ts';

const r = (id: number, merchant: string, portal: string, rate: string, category = '', clickUrl: string | null = null): PortalRateRow =>
  ({ id, merchant, category, portal, rate, clickUrl });

test('rateValue in dollars and points', () => {
  assert.equal(rateValue('TopCashback', '4%', 200), '$8.00');
  assert.equal(rateValue('Rakuten', '5', 200), '1,000 pts');
  assert.equal(rateValue('TopCashback', 'Excluded', 200), null);
  assert.equal(rateValue('TopCashback', '4%', null), null);
});

test('merchantForHost matches names after dropping punctuation', () => {
  const ms = ['Best Buy', 'Walmart', "Lowe's", 'Amazon'];
  assert.equal(merchantForHost('www.bestbuy.com', ms), 'Best Buy');
  assert.equal(merchantForHost('walmart.com', ms), 'Walmart');
  assert.equal(merchantForHost('www.lowes.com', ms), "Lowe's");
  assert.equal(merchantForHost('smile.amazon.com', ms), 'Amazon');
  assert.equal(merchantForHost('shop.example.com', ms), null);
  assert.equal(merchantForHost(null, ms), null);
  assert.equal(merchantForHost('amazon.co.uk', ms), 'Amazon');
  // lookalike hosts are not the merchant
  assert.equal(merchantForHost('bestbuy-deals.example', ms), null);
  assert.equal(merchantForHost('bestbuyfake.com', ms), null);
  assert.equal(merchantForHost('amazonia.com', ms), null);
});

test('best first, excluded last, points between, ignored hidden', () => {
  const rates = [
    r(1, 'Best Buy', 'Rakuten', '2'),
    r(2, 'Best Buy', 'TopCashback', '3%'),
    r(3, 'Best Buy', 'BeFrugal', '5%'),
    r(4, 'Best Buy', 'Capital One', 'Excluded'),
    r(5, 'Best Buy', 'Ignored', '9%'),
    r(6, 'Walmart', 'Other', '9%'),
  ];
  const o = portalOptions(rates, { merchant: 'best buy', ignored: ['ignored'], dealValue: 100 });
  assert.deepEqual(o.map(x => x.portal), ['BeFrugal', 'TopCashback', 'Rakuten', 'Capital One']);
  assert.equal(o[0].value, '$5.00');
  assert.equal(o[2].value, '200 pts');
  assert.equal(o[3].excluded, true);
});

test('a category row beats the all-categories row for the same portal; other categories drop out', () => {
  const rates = [
    r(1, 'Target', 'TopCashback', '1%'),
    r(2, 'Target', 'TopCashback', '6%', 'Electronics'),
    r(3, 'Target', 'BeFrugal', '8%', 'Toys'),
  ];
  const e = portalOptions(rates, { merchant: 'Target', category: 'electronics' });
  assert.deepEqual(e.map(x => [x.portal, x.rate]), [['TopCashback', '6%']]);
  const none = portalOptions(rates, { merchant: 'Target' });
  assert.deepEqual(none.map(x => [x.portal, x.rate]), [['TopCashback', '1%']]);
});

test('clickUrl comes from any category row of that merchant and portal', () => {
  const rates = [r(1, 'Target', 'TopCashback', '1%'), r(2, 'Target', 'TopCashback', '6%', 'Electronics', 'https://portal.example/target')];
  assert.equal(portalOptions(rates, { merchant: 'Target' })[0].clickUrl, 'https://portal.example/target');
  assert.equal(portalOptions([r(1, 'Target', 'X', '1%')], { merchant: 'Target' })[0].clickUrl, null);
});

test('no merchant, no options', () => {
  assert.deepEqual(portalOptions([r(1, 'A', 'B', '1%')], { merchant: '' }), []);
});

test('parseClickUrl accepts http(s), clears on blank, rejects the rest', () => {
  assert.equal(parseClickUrl('https://portal.example/stores/target'), 'https://portal.example/stores/target');
  assert.equal(parseClickUrl('  '), '');
  assert.equal(parseClickUrl('javascript:alert(1)'), null);
  assert.equal(parseClickUrl('portal.example'), null);
  assert.equal(parseClickUrl(5), null);
});

test('goHref builds the contract the extension also uses', () => {
  const h = goHref({ url: 'https://a.example/p?x=1&y=2', src: 'bfmr', merchant: 'Best Buy', value: '12.5' });
  const q = new URL(h, 'https://t.example').searchParams;
  assert.equal(q.get('url'), 'https://a.example/p?x=1&y=2');
  assert.equal(q.get('src'), 'bfmr');
  assert.equal(q.get('merchant'), 'Best Buy');
  assert.equal(q.get('value'), '12.5');
  assert.equal(goHref({ url: 'https://a.example' }), '/go?url=https%3A%2F%2Fa.example');
});

test('each option carries its own merchant spelling and the PUT sends it', () => {
  const rates = [r(1, 'BestBuy', 'TopCashback', '3%', '', 'https://tcb.example/bb'), r(2, 'Best Buy', 'Rakuten', '2')];
  const o = portalOptions(rates, { merchant: 'Best Buy' });
  assert.deepEqual(o.map(x => [x.portal, x.merchant]).sort(), [['Rakuten', 'Best Buy'], ['TopCashback', 'BestBuy']]);
  const tcb = o.find(x => x.portal === 'TopCashback')!;
  assert.deepEqual(clickUrlBody(tcb, 'https://x.example/'), { merchant: 'BestBuy', portal: 'TopCashback', clickUrl: 'https://x.example/' });
});
