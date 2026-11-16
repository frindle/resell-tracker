import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePayPalReceipt, isPayPalSender, paypalDate } from './paypalReceipt.ts';
import { parseOrderEmail, isOrderEmail } from './emailParse.ts';

// Synthetic fixtures only: made-up merchant, amounts, card digits and ids.
const TXN = 'ABCDE12345FGHIJ67';
const PP_ORDER_ID = '1234567890123456789';

function receipt(over: { subject?: string; lead?: string; funding?: string[]; txn?: string; date?: string } = {}) {
  const subject = over.subject ?? 'Example Store Inc: $123.45 USD';
  const body = [
    over.lead ?? 'You authorized $123.45 USD to Example Store Inc',
    'Merchant',
    'Example Store Inc',
    `Transaction date ${over.date ?? 'Nov 15, 2026'}`,
    `Order ID ${PP_ORDER_ID}`,
    ...(over.funding ?? ['Authorized with', 'VISA', 'Credit ••4242']),
    `Transaction ID: ${over.txn ?? TXN}`,
  ].join('\n');
  return { subject, body };
}

test('a PayPal authorization receipt: merchant, amount, date, card and transaction id', () => {
  const { subject, body } = receipt();
  assert.deepEqual(parsePayPalReceipt(subject, body), {
    merchant: 'Example Store Inc', amount: 123.45, date: '2026-11-15', network: 'Visa', last4: '4242', txnId: TXN,
  });
});

test('the other sentence forms read the same amount and merchant', () => {
  for (const lead of [
    'You sent a payment of $123.45 USD to Example Store Inc',
    'You paid $123.45 USD to Example Store Inc',
    'You sent $123.45 USD to Example Store Inc',
  ]) {
    const { subject, body } = receipt({ lead });
    const r = parsePayPalReceipt(subject, body);
    assert.equal(r?.amount, 123.45, lead);
    assert.equal(r?.merchant, 'Example Store Inc', lead);
  }
});

test('the merchant falls back to the sentence, then to the subject', () => {
  const noLabel = ['You paid $123.45 USD to Example Store Inc.', 'Transaction date Nov 15, 2026', `Transaction ID: ${TXN}`].join('\n');
  assert.equal(parsePayPalReceipt('Receipt', noLabel)?.merchant, 'Example Store Inc');
  const subjectOnly = ['Transaction date Nov 15, 2026', `Transaction ID: ${TXN}`].join('\n');
  const r = parsePayPalReceipt('Example Store Inc: $123.45 USD', subjectOnly);
  assert.equal(r?.merchant, 'Example Store Inc');
  assert.equal(r?.amount, 123.45);
});

test('every way of writing the last four digits', () => {
  for (const line of ['Credit ••4242', 'Credit ••••4242', 'Credit x-4242', 'Credit ending in 4242', 'Credit ending 4242', 'Credit ****4242']) {
    const { subject, body } = receipt({ funding: ['Authorized with', 'VISA', line] });
    assert.equal(parsePayPalReceipt(subject, body)?.last4, '4242', line);
  }
});

test('the funding label and the card networks', () => {
  for (const label of ['Paid with', 'Funding source', 'Authorized with']) {
    const { subject, body } = receipt({ funding: [label, 'Mastercard', 'Debit ••4242'] });
    const r = parsePayPalReceipt(subject, body);
    assert.equal(r?.network, 'Mastercard', label);
    assert.equal(r?.last4, '4242', label);
  }
  assert.equal(parsePayPalReceipt(...Object.values(receipt({ funding: ['Paid with', 'American Express', 'Credit ••4242'] })) as [string, string])?.network, 'Amex');
});

test('PayPal balance or a bank gives no card', () => {
  for (const funding of [['Paid with', 'PayPal balance'], ['Funding source', 'Example Bank Checking ••4242'], ['Paid with', 'Bank account']]) {
    const { subject, body } = receipt({ funding });
    const r = parsePayPalReceipt(subject, body);
    assert.equal(r?.network, null, funding.join(' '));
    assert.equal(r?.last4, null, funding.join(' '));
    assert.equal(r?.txnId, TXN);
  }
});

test('no funding section at all gives no card', () => {
  const { subject, body } = receipt({ funding: [] });
  const r = parsePayPalReceipt(subject, body);
  assert.equal(r?.last4, null);
  assert.equal(r?.network, null);
});

test('values on the same line as their label, as flattened HTML gives them', () => {
  const body = [
    'You authorized $1,234.50 USD to Example Store Inc',
    'Merchant Example Store Inc',
    'Transaction date November 3, 2026',
    'Authorized with VISA Credit ••4242',
    `Transaction ID ${TXN}`,
  ].join('\n');
  assert.deepEqual(parsePayPalReceipt('Example Store Inc: $1,234.50 USD', body), {
    merchant: 'Example Store Inc', amount: 1234.5, date: '2026-11-03', network: 'Visa', last4: '4242', txnId: TXN,
  });
});

test('PayPal\'s own Order ID is not the transaction id', () => {
  const { subject, body } = receipt();
  assert.notEqual(parsePayPalReceipt(subject, body)?.txnId, PP_ORDER_ID);
});

test('not a receipt: no amount, no merchant or no transaction id', () => {
  assert.equal(parsePayPalReceipt('Your statement is ready', 'Nothing about a payment here.'), null);
  const { subject, body } = receipt();
  assert.equal(parsePayPalReceipt(subject, body.replace(/Transaction ID.*/, '')), null);
  assert.equal(parsePayPalReceipt('Hello', 'Transaction ID: ' + TXN), null);
});

test('paypalDate', () => {
  assert.equal(paypalDate('Nov 15, 2026'), '2026-11-15');
  assert.equal(paypalDate('January 2, 2027'), '2027-01-02');
  assert.equal(paypalDate('tomorrow'), '');
});

test('isPayPalSender', () => {
  assert.equal(isPayPalSender('PayPal <service@paypal.com>'), true);
  assert.equal(isPayPalSender('service@mail.paypal.com'), true);
  assert.equal(isPayPalSender('someone@notpaypal.example.com'), false);
  assert.equal(isPayPalSender('auto-confirm@amazon.com'), false);
});

// ---- through parseOrderEmail ----------------------------------------------

test('a forwarded PayPal receipt parses as kind payment, platform Unknown', () => {
  const { subject, body } = receipt({ subject: 'Example Store Inc: $123.45 USD' });
  const forward = [
    'FYI', '', '---------- Forwarded message ---------',
    'From: PayPal <service@paypal.example.com>', 'Date: Sun, Nov 15, 2026 at 10:30 AM', `Subject: ${subject}`, 'To: sam@orders.example.test', '', body,
  ].join('\n');
  const p = parseOrderEmail({ subject: `Fwd: ${subject}`, from: 'sam@orders.example.test', text: forward });
  assert.equal(p.kind, 'payment');
  assert.equal(p.platform, 'Unknown');
  assert.equal(p.orderNumber, '', 'PayPal\'s Order ID is not an order number');
  assert.equal(p.cost, 123.45);
  assert.equal(p.payment?.last4, '4242');
  assert.equal(p.payment?.txnId, TXN);
  assert.equal(isOrderEmail(p), true, 'a receipt is kept by the shared inbox');
});

test('a merchant named Amazon does not turn the receipt into an Amazon order email', () => {
  const { subject, body } = receipt({ subject: 'Amazon: $123.45 USD', lead: 'You authorized $123.45 USD to Amazon' });
  const p = parseOrderEmail({ subject, from: 'PayPal <service@paypal.example.com>', text: body.replace('Example Store Inc', 'Amazon') });
  assert.equal(p.kind, 'payment');
  assert.equal(p.platform, 'Unknown');
});

test('PayPal mail that is not a receipt stays an ordinary email', () => {
  const p = parseOrderEmail({ subject: 'Your monthly statement', from: 'service@paypal.example.com', text: 'Statement attached.' });
  assert.equal(p.kind, 'other');
  assert.equal(p.payment, undefined);
});

test('a receipt-looking email from another sender is not a payment', () => {
  const { subject, body } = receipt();
  const p = parseOrderEmail({ subject, from: 'billing@shop.example.test', text: body });
  assert.notEqual(p.kind, 'payment');
});
