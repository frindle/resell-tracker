import { test } from 'node:test';
import assert from 'node:assert/strict';
import { depositLabel, acceptOptions, linkBody, type Suggestion } from './acceptOptions.ts';
import { transferRefusal } from './transferPair.ts';
import { hideRefusal } from './hide.ts';

const fmt = (c: number) => `$${(c / 100).toFixed(2)}`;

test('no suggestion, no accept options', () => {
  assert.deepEqual(acceptOptions(null, fmt), []);
});

test('a single order, transfer or pair is one plain Accept', () => {
  for (const sg of [{ kind: 'order', orderIds: [5] }, { kind: 'transfer', txnId: 9 }, { kind: 'pair', txnId: 9 }] as Suggestion[]) {
    const o = acceptOptions(sg, fmt);
    assert.equal(o.length, 1);
    assert.deepEqual([o[0].label, o[0].body], ['Accept', { action: 'accept' }]);
  }
});

test('several orders or returns give one option each, naming the one to link', () => {
  const o = acceptOptions({ kind: 'order', orderIds: [5, 6] }, fmt);
  assert.deepEqual(o.map(x => x.body), [{ action: 'accept', orderId: 5 }, { action: 'accept', orderId: 6 }]);
  const r = acceptOptions({ kind: 'refund', returns: [{ returnId: 1, orderId: 5 }, { returnId: 2, orderId: 6 }] }, fmt);
  assert.deepEqual(r.map(x => x.label), ['Accept return #1', 'Accept return #2']);
});

test('split sets show their total; deposit options carry their order ids', () => {
  const s = acceptOptions({ kind: 'split', orderId: 3, subsets: [[1, 2], [1, 4]], amounts: { 1: 1000, 2: 250, 4: 300 } }, fmt);
  assert.deepEqual(s.map(x => x.label), ['Accept 2 charges ($12.50)', 'Accept 2 charges ($13.00)']);
  assert.deepEqual(s[1].body, { action: 'accept', txnIds: [1, 4] });
  const d = acceptOptions({ kind: 'deposit', buyerId: null, aliased: false, options: [
    { how: 'exact', parts: [{ orderId: 7, cents: 100 }, { orderId: 8, cents: 200 }], totalCents: 300, shortfallCents: 0 },
    { how: 'exact', parts: [{ orderId: 9, cents: 300 }], totalCents: 300, shortfallCents: 0 },
  ] }, fmt);
  assert.deepEqual(d.map(x => x.label), ['Accept #7+#8', 'Accept #9']);
  assert.deepEqual(d[0].body, { action: 'accept', orderIds: [7, 8] });
  const one = acceptOptions({ kind: 'deposit', buyerId: null, aliased: false, options: [{ how: 'exact', parts: [{ orderId: 9, cents: 300 }], totalCents: 300, shortfallCents: 0 }] }, fmt);
  assert.equal(one[0].label, 'Accept 1 order');
});

test('cashback: one option is plain, several name their order', () => {
  const unit = (orderId: number) => ({ orderId, cents: 50 });
  assert.equal(acceptOptions({ kind: 'cashback', portal: false, options: [{ aggregate: true, units: [unit(1), unit(2)] }] }, fmt)[0].label, 'Accept 2 orders');
  const many = acceptOptions({ kind: 'cashback', portal: false, options: [{ aggregate: false, units: [unit(1)] }, { aggregate: false, units: [unit(2)] }] }, fmt);
  assert.deepEqual(many.map(x => x.body), [{ action: 'accept', orderId: 1 }, { action: 'accept', orderId: 2 }]);
});

test('linkBody: #id is an order id, r#id a return id, t#id a bank row to pair as a transfer, anything else an order number', () => {
  assert.deepEqual(linkBody('t#407'), { action: 'transfer', partnerId: 407 });
  assert.deepEqual(linkBody(' #12 '), { action: 'link', orderId: 12 });
  assert.deepEqual(linkBody('R#7'), { action: 'link', returnId: 7 });
  assert.deepEqual(linkBody('111-222'), { action: 'link', orderNumber: '111-222' });
});

test('an account can be hidden only while it is not in the books', () => {
  assert.equal(hideRefusal({ hidden: true, creditCardId: null, ledgerAccountId: null }), null);
  assert.match(hideRefusal({ hidden: true, creditCardId: 3, ledgerAccountId: null }) ?? '', /in your books/);
  assert.match(hideRefusal({ hidden: true, creditCardId: null, ledgerAccountId: 4 }) ?? '', /in your books/);
  assert.equal(hideRefusal({ hidden: false, creditCardId: 3, ledgerAccountId: 4 }), null);
});

test('a transfer pairs two open rows of different accounts, the same amount going opposite ways', () => {
  const t = { id: 1, bankAccountId: 10, amountCents: -30000, matchStatus: 'unmatched' };
  assert.equal(transferRefusal(t, { id: 2, bankAccountId: 11, amountCents: 30000, matchStatus: 'suggested' }), null);
  assert.match(transferRefusal(t, null) ?? '', /no bank row/);
  assert.match(transferRefusal(t, { ...t }) ?? '', /other side/);
  assert.match(transferRefusal(t, { id: 2, bankAccountId: 10, amountCents: 30000, matchStatus: 'unmatched' }) ?? '', /different accounts/);
  assert.match(transferRefusal(t, { id: 2, bankAccountId: 11, amountCents: -30000, matchStatus: 'unmatched' }) ?? '', /same amount/);
  assert.match(transferRefusal(t, { id: 2, bankAccountId: 11, amountCents: 40700, matchStatus: 'unmatched' }) ?? '', /same amount/);
  assert.match(transferRefusal(t, { id: 2, bankAccountId: 11, amountCents: 30000, matchStatus: 'matched' }) ?? '', /already linked/);
});

test('deposit options with many orders name only what sets each apart, so the buttons are not cut off', () => {
  const a = [766, 876, 884, 896, 901, 904, 915], b = [766, 876, 884, 896, 901, 905, 915], c = [766, 876, 884, 896, 902, 904, 915];
  const all = [a, b, c];
  assert.equal(depositLabel(a, all), 'Accept 7 orders, with #901 #904');
  assert.equal(depositLabel(b, all), 'Accept 7 orders, with #901 #905');
  assert.equal(depositLabel(c, all), 'Accept 7 orders, with #902 #904');
  assert.equal(depositLabel([1, 2], [[1, 2], [3]]), 'Accept #1+#2');
  assert.equal(depositLabel([1, 2, 3, 4, 5, 6, 7, 8], [[1, 2, 3, 4, 5, 6, 7, 8], [9, 10, 11, 12]]), 'Accept 8 orders, with #1 #2 #3 …');
});
