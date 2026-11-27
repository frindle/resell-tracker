import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWalmartReturnLabel, pickReturnRowForLabel, orderDigits } from './walmartReturnLabel.ts';
import { parseRawOrderEmail } from './emailMessage.ts';

// Synthetic numbers and addresses only. The two FedEx numbers pass the 12-digit check.
const FEDEX = '781234567011';
const FEDEX2 = '781234567022';
const ORDER = '200012345678901';

const body = (extra: string) => `Hi Sam,\n\nYour return label is ready. Print it or show the QR code at a drop-off point.\n\nReturn for order #${ORDER}\n${extra}\n\nQuestions? Visit walmart.com/help.`;

test('reads the FedEx tracking from a return-label email, in plain digits or 4-4-4 groups', () => {
  for (const t of [FEDEX, '7812 3456 7011']) {
    const r = parseWalmartReturnLabel({ platform: 'Walmart', subject: 'Your return label is ready', body: body(`FedEx tracking number: ${t}`), orderNumber: ORDER });
    assert.deepEqual(r, { orderNumber: ORDER, trackingNumbers: [FEDEX] });
  }
});

test('reads the number from a FedEx tracking link', () => {
  const r = parseWalmartReturnLabel({
    platform: 'Walmart', subject: 'Print your return label', body: body('Track it with FedEx'),
    html: `<a href="https://www.fedex.com/fedextrack/?trknbr=${FEDEX}">Track</a>`, orderNumber: ORDER,
  });
  assert.deepEqual(r?.trackingNumbers, [FEDEX]);
});

test('never takes the order number for tracking', () => {
  const r = parseWalmartReturnLabel({ platform: 'Walmart', subject: 'Your return label', body: body(`FedEx order ${ORDER}`), orderNumber: ORDER });
  assert.equal(r, null);
});

test('not a return label: other platforms, order and shipping mail, refund notices, no FedEx number', () => {
  const ok = body(`FedEx tracking number: ${FEDEX}`);
  assert.equal(parseWalmartReturnLabel({ platform: 'Amazon', subject: 'Your return label', body: ok }), null);
  assert.equal(parseWalmartReturnLabel({ platform: 'Walmart', subject: 'Your order has shipped', body: `FedEx tracking number: ${FEDEX}`, orderNumber: ORDER }), null);
  assert.equal(parseWalmartReturnLabel({ platform: 'Walmart', subject: 'Refund issued for your return', body: ok }), null);
  assert.equal(parseWalmartReturnLabel({ platform: 'Walmart', subject: 'Your return label', body: body('No carrier details yet') }), null);
});

test('picks the one open return row without tracking', () => {
  assert.deepEqual(pickReturnRowForLabel([{ id: 1, status: 'requested', returnTracking: null }], [FEDEX]), { id: 1, tracking: FEDEX });
  // A refunded row and a row that has its number are not candidates.
  assert.deepEqual(pickReturnRowForLabel([
    { id: 1, status: 'refunded', returnTracking: null }, { id: 2, status: 'in_transit', returnTracking: FEDEX2 }, { id: 3, status: 'requested', returnTracking: null },
  ], [FEDEX]), { id: 3, tracking: FEDEX });
});

test('leaves ambiguous or already-filled rows alone', () => {
  const two = [{ id: 1, status: 'requested', returnTracking: null }, { id: 2, status: 'requested', returnTracking: null }];
  assert.equal(pickReturnRowForLabel(two, [FEDEX]), null);
  assert.equal(pickReturnRowForLabel([{ id: 1, status: 'requested', returnTracking: null }], [FEDEX, FEDEX2]), null);
  assert.equal(pickReturnRowForLabel([{ id: 1, status: 'requested', returnTracking: '7812 3456 7011' }], [FEDEX]), null);
  assert.equal(pickReturnRowForLabel([], [FEDEX]), null);
});

test('orderDigits ignores dashes', () => assert.equal(orderDigits('2000123-456789'), '2000123456789'));

test('a raw Walmart return-label message carries returnLabel and is not an order update', async () => {
  const raw = [
    'From: Walmart <help@walmart.example.test>', 'To: sam@orders.example.test', 'Subject: Your return label is ready',
    'Date: Sun, 15 Nov 2026 14:02:15 -0800', 'Message-ID: <rl-1@walmart.example.test>', 'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8', '', body(`FedEx tracking number: ${FEDEX}`),
  ].join('\r\n');
  const m = await parseRawOrderEmail(raw, 'k1', { shared: true });
  assert.equal(m?.platform, 'Walmart');
  assert.deepEqual(m?.returnLabel?.trackingNumbers, [FEDEX]);
  assert.equal(orderDigits(m?.returnLabel?.orderNumber), ORDER);
});
