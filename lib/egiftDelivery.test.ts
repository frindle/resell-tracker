import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractEgiftDelivery, findDeliveryLink, findOrderNumber, findRecipient, findTrackedDeliveryLinks } from './egiftDelivery.ts';
import { parseRawOrderEmail } from './emailMessage.ts';

// Synthetic only: the structure is a guess until a real masked email has been checked.
const LINK = 'https://www.memberedelivery.com/?login=SYNTHETICTOKEN';
const HTML = `<html><body><p>Your eGift is ready.</p><p>Order Number: 000000000</p>
<p>Sent to buyer@example.com</p><a href="${LINK.replace('?', '?lang=en&amp;')}&amp;x=1">Access eGift</a>
<a href="https://www.costco.com/help">Help</a></body></html>`;

test('finds the delivery link in an href and decodes &amp;', () => {
  const l = findDeliveryLink(HTML, '');
  assert.ok(l && new URL(l).searchParams.get('login') === 'SYNTHETICTOKEN');
  assert.equal(new URL(l!).hostname, 'www.memberedelivery.com');
});

test('finds a bare link in plain text and ignores other hosts and logins-less links', () => {
  assert.ok(findDeliveryLink('', `Open ${LINK}.`));
  assert.equal(findDeliveryLink('<a href="https://evil.example/?login=SYNTHETICTOKEN">x</a>', ''), null);
  assert.equal(findDeliveryLink('<a href="https://www.memberedelivery.com/">x</a>', ''), null);
  assert.equal(findDeliveryLink('<a href="http://www.memberedelivery.com/?login=SYNTHETICTOKEN">x</a>', ''), null);
});

test('order number and recipient', () => {
  assert.equal(findOrderNumber('Order Number: 000000000'), '000000000');
  assert.equal(findOrderNumber('Costco Order # 000000000 placed'), '000000000');
  assert.equal(findOrderNumber('nothing'), '');
  assert.equal(findRecipient('Sent to Buyer@Example.COM today'), 'Buyer@example.com');
  assert.equal(findRecipient('no address'), null);
});

test('extractEgiftDelivery combines them; no link means not a delivery email', () => {
  const d = extractEgiftDelivery({ html: HTML, text: 'Order Number: 000000000\nSent to buyer@example.com' });
  assert.equal(d?.orderNumber, '000000000');
  assert.equal(d?.recipient, 'buyer@example.com');
  assert.equal(extractEgiftDelivery({ html: '<p>Thanks for your order</p>', text: 'Order Number: 000000000' }), null);
  const fb = extractEgiftDelivery({ html: HTML, text: '', parsedOrderNumber: '111111111', toAddress: 'me@example.com' });
  assert.equal(fb?.orderNumber, '111111111');
  assert.equal(fb?.recipient, 'me@example.com');
});

function mime(html: string): string {
  return [
    'From: Costco <eGift@costco.com>', 'To: buyer@example.com', 'Subject: Your Costco eGift is ready',
    'Message-ID: <synthetic@example.com>', 'Date: Mon, 16 Nov 2026 10:00:00 -0800', 'MIME-Version: 1.0',
    'Content-Type: text/html; charset=utf-8', '', html,
  ].join('\r\n');
}

test('parseRawOrderEmail attaches the delivery without leaking it into JSON or copies', async () => {
  const row = await parseRawOrderEmail(mime(HTML), 1, { shared: true });
  assert.ok(row);
  assert.equal(row!.egiftDelivery?.orderNumber, '000000000');
  assert.ok(row!.egiftDelivery?.link?.includes('login='));
  assert.ok(!JSON.stringify(row).includes('SYNTHETICTOKEN'));
  assert.ok(!JSON.stringify(row).includes('memberedelivery'));
  assert.equal((({ ...row! }) as { egiftDelivery?: unknown }).egiftDelivery, undefined);
});

test('personal inbox: the To address is the recipient when the body does not say', async () => {
  const html = `<p>Order Number: 000000000</p><a href="${LINK}">Access eGift</a>`;
  const row = await parseRawOrderEmail(mime(html), 2, {});
  assert.equal(row!.egiftDelivery?.recipient, 'buyer@example.com');
  const shared = await parseRawOrderEmail(mime(html), 3, { shared: true });
  assert.equal(shared!.egiftDelivery?.recipient, 'buyer@example.com'); // a shared inbox's To header is the inbox address
});

test('the envelope recipient wins over the To header and the body line', async () => {
  const html = `<p>Order Number: 000000000</p><p>Sent to other@example.com</p><a href="${LINK}">Access eGift</a>`;
  const row = await parseRawOrderEmail(mime(html), 5, { shared: true, envelopeTo: 'Orders@Inbox.Example.test' });
  assert.equal(row!.egiftDelivery?.recipient, 'Orders@inbox.example.test');
  const noEnv = await parseRawOrderEmail(mime(html), 6, { shared: true });
  assert.equal(noEnv!.egiftDelivery?.recipient, 'buyer@example.com');
  const bodyOnly = extractEgiftDelivery({ html, text: 'Order Number: 000000000\nSent to other@example.com' });
  assert.equal(bodyOnly?.recipient, 'other@example.com');
});

test('an ordinary Costco email has no delivery', async () => {
  const row = await parseRawOrderEmail(mime('<p>Thank you for your order</p><p>Order Number: 000000000</p>'), 4, { shared: true });
  assert.equal(row?.egiftDelivery, undefined);
});

// Shape of the real "Your E-Delivery Order #..." email (checked on a masked copy): only click-tracking
// links on link.memberedelivery.com, plus addy.io alias links whose query names the sender.
const TRACKED = 'https://link.memberedelivery.com/ls/click?upn=SYNTHETICUPN1';
const TRACKED_UNSUB = 'https://link.memberedelivery.com/ls/click?upn=SYNTHETICUPN2';
const TRACKED_HTML = `<html><body><p>Your E-Delivery Order #000000002</p>
<a href="https://app.addy.io/aliases/x/actions?action=block&amp;email=noreply%40memberedelivery.com&amp;signature=s">Block</a>
<a href="${TRACKED}"><span>View Your eGift</span></a>
<a href="${TRACKED_UNSUB}">Unsubscribe</a></body></html>`;

test('a delivery email with only click-tracking links yields tracked links, no direct link', () => {
  const d = extractEgiftDelivery({ html: TRACKED_HTML, text: 'Your E-Delivery Order #000000002', toAddress: 'me@example.com' });
  assert.ok(d);
  assert.equal(d!.link, null);
  assert.deepEqual(d!.trackedLinks, [TRACKED]); // the unsubscribe link and the addy.io links are never candidates
  assert.equal(d!.orderNumber, '000000002');
  assert.equal(d!.recipient, 'me@example.com');
});

test('a direct link wins over tracked links; non-delivery hosts and plain http are not tracked links', () => {
  const both = extractEgiftDelivery({ html: `${TRACKED_HTML}<a href="${LINK}">x</a>`, text: '' });
  assert.ok(both?.link?.includes('login=SYNTHETICTOKEN'));
  assert.equal(both?.trackedLinks, undefined);
  assert.deepEqual(findTrackedDeliveryLinks('<a href="https://evil.example/ls/click?upn=x">View</a>', ''), []);
  assert.deepEqual(findTrackedDeliveryLinks('<a href="http://link.memberedelivery.com/ls/click?upn=x">View</a>', ''), []);
  assert.deepEqual(findTrackedDeliveryLinks('<a href="https://link.memberedelivery.com/other?upn=x">View</a>', ''), []);
  assert.deepEqual(findTrackedDeliveryLinks('', `Manage preferences: ${TRACKED_UNSUB}\nView: ${TRACKED}`), [TRACKED]);
  // a SendGrid-only tracked link is a hop, not evidence of a delivery email
  assert.equal(extractEgiftDelivery({ html: '<a href="https://u1.ct.sendgrid.net/ls/click?upn=x">View</a>', text: '' }), null);
});
