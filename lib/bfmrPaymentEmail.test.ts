// Group payment emails: invented text only (fake ids, trackings and amounts), laid out the ways BFMR's mail is read.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRemittanceEmail, pairTrackingAmounts, dayIn } from './remittanceParse.ts';
import { REMITTANCE_PARSERS } from './remittanceParsers.ts';
import { parseRawOrderEmail } from './emailMessage.ts';

const senders = ['payments@bfmr.example'.replace('.example', '.com')];
const email = (subject: string, body: string, who = senders) => ({ senders: who, subject, body, day: '2027-02-10' });

const ONE_LINE = `Hi there,
Your payment has been sent.
Payment ID: PAY-48213
Payment date: 02/09/2027
Total paid: $300.50

Tracking   Amount
1ZTEST000000000001   $100.25
tba000000000002   $200.25
`;

test('bfmr: one line per tracking number, labelled id, total and date', () => {
  const r = parseRemittanceEmail(REMITTANCE_PARSERS, email('Your BFMR payment of $300.50', ONE_LINE))!;
  assert.equal(r.group, 'bfmr');
  assert.equal(r.ref, 'PAY-48213');
  assert.equal(r.totalCents, 30050);
  assert.equal(r.paidDay, '2027-02-09');
  assert.deepEqual(r.lines, [{ tracking: '1ZTEST000000000001', amountCents: 10025 }, { tracking: 'TBA000000000002', amountCents: 20025 }]);
});

test('bfmr: label per line (tracking, then its value on the next line)', () => {
  const body = 'Payout ID: 7788\nTotal payout: $90.00\nTracking: 940010000000000000001\nValue: $40.00\nTracking: 940010000000000000002\nValue: $50.00\n';
  const r = parseRemittanceEmail(REMITTANCE_PARSERS, email('Payout sent', body))!;
  assert.equal(r.ref, '7788');
  assert.equal(r.paidDay, '2027-02-10'); // no date line: the email's own day
  assert.deepEqual(r.lines.map(l => l.amountCents), [4000, 5000]);
});

test('bfmr: a total-only email has no lines and no id', () => {
  const r = parseRemittanceEmail(REMITTANCE_PARSERS, email('Payment sent: $12.00', 'We paid you.'))!;
  assert.equal(r.ref, null);
  assert.equal(r.totalCents, 1200);
  assert.deepEqual(r.lines, []);
});

test('bfmr: deal blasts, other senders and totals-less mail are not payments', () => {
  assert.equal(parseRemittanceEmail(REMITTANCE_PARSERS, email('New deals today', 'Total paid: $5.00')), null);
  assert.equal(parseRemittanceEmail(REMITTANCE_PARSERS, email('Payment sent', 'Total paid: $5.00', ['x@other.example.test'])), null);
  assert.equal(parseRemittanceEmail(REMITTANCE_PARSERS, email('Payment sent', 'thanks')), null);
});

test('pairing: total lines are never pairs, two tracking numbers on a line are not guessed, repeats add up', () => {
  const lines = pairTrackingAmounts('1ZTEST000000000001 $10.00\n1ZTEST000000000001 $5.00\n1ZTEST000000000003 1ZTEST000000000004 $9.00\nTotal $24.00\nSubtotal 1ZTEST000000000005 $1.00');
  assert.deepEqual(lines, [{ tracking: '1ZTEST000000000001', amountCents: 1500 }]);
});

test('dayIn reads ISO, US and written dates', () => {
  assert.equal(dayIn('on 2027-03-04'), '2027-03-04');
  assert.equal(dayIn('3/4/2027'), '2027-03-04');
  assert.equal(dayIn('March 4th, 2027'), '2027-03-04');
  assert.equal(dayIn('soon'), null);
});

test('inbox mail from a group sender with a payment body becomes a remittance, never an order', async () => {
  const raw = [
    'From: Pay <payments@bfmr.com>', 'To: inbox@orders.example.test', 'Subject: Your payment of $20.00',
    'Date: Wed, 10 Feb 2027 09:00:00 -0800', 'Message-ID: <p1@bfmr.example.test>', 'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8', '', 'Payment ID: PAY-1\nTotal paid: $20.00\n1ZTEST000000000009 $20.00\n',
  ].join('\r\n');
  const withFlag = await parseRawOrderEmail(raw, 'm1', { shared: true, bgReceipts: true });
  assert.equal(withFlag?.remittance?.ref, 'PAY-1');
  assert.equal(withFlag?.remittance?.paidDay, '2027-02-10');
  assert.equal(withFlag?.kind, 'other');
  assert.equal(await parseRawOrderEmail(raw, 'm1', { shared: true }), null);
});

// BFMR's real "Payment Sent" layout (invented values): HTML only, sent from buyformeretail.com through an addy.io reverse
// alias, one table row per item (tracking, item, quantity, unit value, line value), a "Total" row with the item count, and
// no payment id or date. A box with two items has its tracking number on two rows.
// The cells sit on their own source lines, as BFMR's mail has them.
const tableRow = (...cells: string[]) => ['        <tr>', ...cells.map(c => `    <td> ${c} </td>`), '        </tr>'];
const PAYMENT_SENT_HTML = [
  '<p>Payment Sent</p>', '<p>Hey Test!</p>', '<p>We&rsquo;ve sent payment over to your bank!</p>',
  '<table>', '  <tr>', '    <td colspan="5">', '      <p><strong>Tracking Numbers:</strong><br />', '    </td>', '  </tr>',
  ...tableRow('TBA000000000101', 'Test Earbuds - USB-C Case - TST1LL/A', '1', '$199.00', '$199.00'),
  ...tableRow('TBA000000000102', 'Test Watch - 42mm - Sport Band', '2', '$350.00', '$700.00'),
  ...tableRow('TBA000000000101', 'Test Cable - 1m', '1', '$15.50', '$15.50'),
  '  <tr>', '    <td colspan="2">Total </td>', '    <td>4</td>', '    <td></td>', '    <td>$914.50</td>', '  </tr>',
  '  <tr>', '    <td colspan="4"> </td>', '  </tr>', '</table>', '<p>Thank You!</p>',
].join('\r\n');

const paymentSentRaw = (subject: string, html: string) => [
  `From: "BFMR 'deals at buyformeretail.com'" <bfmr+deals=buyformeretail.com@alias.example.test>`,
  'To: bfmr@alias.example.test', `Subject: ${subject}`, 'Date: Fri, 12 Feb 2027 16:00:00 -0800',
  'Message-ID: <ps1@alias.example.test>', 'MIME-Version: 1.0', 'Content-Type: text/html; charset=utf-8', '', html,
].join('\r\n');

test('bfmr: the real Payment Sent table, from buyformeretail.com via a reverse alias, is a remittance with line values', async () => {
  const row = await parseRawOrderEmail(paymentSentRaw('Payment Sent', PAYMENT_SENT_HTML), 'm2', { shared: true, bgReceipts: true });
  const r = row?.remittance;
  assert.ok(r, 'parsed as a remittance');
  assert.equal(r.group, 'bfmr');
  assert.equal(r.ref, null);
  assert.equal(r.totalCents, 91450);
  assert.equal(r.paidDay, '2027-02-12');
  assert.deepEqual(r.lines, [{ tracking: 'TBA000000000101', amountCents: 21450 }, { tracking: 'TBA000000000102', amountCents: 70000 }]);
  assert.equal(row?.kind, 'other');
});

test('bfmr: payout-increase deal blasts and payment-details notices are not payments, even with a Total row', async () => {
  for (const subject of ['BLACK FRIDAY - PAYOUT INCREASE | TEST LAPTOP | AMAZON DIRECT', 'Payment Information Changed']) {
    const row = await parseRawOrderEmail(paymentSentRaw(subject, PAYMENT_SENT_HTML), 'm3', { shared: true, bgReceipts: true });
    assert.equal(row?.remittance, undefined, subject);
  }
});
