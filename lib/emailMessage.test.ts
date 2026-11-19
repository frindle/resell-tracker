import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRawOrderEmail } from './emailMessage.ts';

// Tuta forwards: no "Forwarded message" marker, the retailer's Date line above
// its From line, an addy.io banner, and a text/plain part that is the HTML
// flattened into one long line. Synthetic people, addresses and numbers.

const ORDER = '111-2223334-4445556';

function tutaForward(subject: string, plain: string, html: string, date = 'Sun, 15 Nov 2026 14:02:15 -0800') {
  return [
    'From: Sam <sam@home.example.test>',
    'To: sam@orders.example.test',
    `Subject: FWD: ${subject}`,
    `Date: ${date}`,
    'Message-ID: <fwd-1@home.example.test>',
    'MIME-Version: 1.0',
    'Content-Type: multipart/alternative; boundary="b1"',
    '',
    '--b1',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    plain,
    '--b1',
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    html,
    '--b1--',
    '',
  ].join('\r\n');
}

const head = (date: string, alias: string, subject: string) =>
  `Date: ${date}\nFrom: ${alias}\nTo: shop@alias.example.test\nSubject: ${subject}\n`;
const headHtml = (date: string, alias: string, subject: string) =>
  `<div>Date: ${date}<br>From: ${alias}<br>To: shop@alias.example.test<br>Subject: ${subject}<br></div>`;
const banner = (sender: string) =>
  `<p>To: shop@alias.example.test (Created automatically by catch-all)</p><p>From: ${sender}</p><p>Actions: Deactivate | Block email | Block domain</p><p>Removed 5 tracking pixels - View report</p>`;
const lines = (ls: string[]) => ls.map(l => `<div>${l}</div>`).join('');

test('Tuta-forwarded Amazon order: reads the HTML part, the original date and sender', async () => {
  const subject = 'Ordered 3 items: Laptops';
  const alias = 'amazon+auto-confirm=amazon.com@alias.example.test';
  const plain = head('Nov 13, 2026, 22:30', alias, subject)
    + `\n> Arriving Tuesday> > 3 Laptops> Sam - springfield, ZZ> Order #> > ‫${ORDER}> > Grand Total: $899.97`;
  const html = headHtml('Nov 13, 2026, 22:30', alias, subject) + '<blockquote>' + banner('auto-confirm@amazon.com')
    + lines(['Arriving Tuesday', '3 Laptops', 'Sam - springfield, ZZ', `Order # &#x202B;${ORDER}`, 'View or edit order', 'Grand Total: $899.97'])
    + '</blockquote>';
  const r = await parseRawOrderEmail(tutaForward(subject, plain, html), 'k1', { shared: true, envelopeTo: 'sam@orders.example.test' });
  assert.ok(r);
  assert.equal(r.platform, 'Amazon');
  assert.equal(r.kind, 'ordered');
  assert.equal(r.forwarded, true);
  assert.equal(r.orderNumber, ORDER);
  assert.equal(r.cost, 899.97);
  assert.equal(r.itemDescription, 'Laptops (3 items)');
  assert.equal(r.shippingAddress, 'Sam - springfield, ZZ');
  assert.equal(r.from, 'auto-confirm@amazon.com');
  assert.deepEqual(r.senders, ['auto-confirm@amazon.com']);
  assert.equal(r.date, new Date(2026, 10, 13, 22, 30).toISOString());
  assert.equal(r.recipients[0], 'sam@orders.example.test');
  assert.ok(r.rawSnippet.startsWith('Arriving Tuesday'), r.rawSnippet);
});

const lenovoLines = (title: string) => [
  title, 'Order Number: K100200300', 'Order Placed: 11/15/2026', 'Sam,',
  'ITEM', 'DELIVERY METHOD', 'QTY', 'TOTAL PRICE',
  'Yoga 7 2-in-1 (14″ AMD)', '83JR0003US', 'Standard', '1', '$767.12',
  'Billing Details:', '100 Test St', 'Springfield', 'US-ZZ', '00001-0001', 'United States of America',
  'Shipping Details:', '100 Test St', 'Springfield', 'US-ZZ', '00001-0001', 'United States of America',
  'Sub total:', '$1,599.99', 'Instant Savings:', '-$750.00', 'Total:', '$767.12',
];

for (const [subject, kind, cost] of [
  ['Thank you for your order!', 'ordered', 767.12],
  ['Your order has shipped!', 'shipped', 767.12],
] as const) {
  test(`Tuta-forwarded Lenovo "${subject}" parses as ${kind}`, async () => {
    const alias = 'lenovo+lenovomail=lenovo.com@alias.example.test';
    const body = lenovoLines(subject);
    const plain = head('Nov 15, 2026, 12:09', alias, subject) + '\n> ' + body.join('> ');
    const html = headHtml('Nov 15, 2026, 12:09', alias, subject) + banner('lenovomail@lenovo.com') + lines(body);
    const r = await parseRawOrderEmail(tutaForward(subject, plain, html), 'k2', { shared: true });
    assert.ok(r);
    assert.equal(r.platform, 'Lenovo');
    assert.equal(r.kind, kind);
    assert.equal(r.orderNumber, 'K100200300');
    assert.equal(r.cost, cost);
    assert.equal(r.itemDescription, 'Yoga 7 2-in-1 (14″ AMD)');
    assert.equal(r.shippingAddress, '100 Test St, Springfield, US-ZZ, 00001-0001');
    assert.equal(r.date, new Date(2026, 10, 15, 12, 9).toISOString());
  });
}

test('a forwarded Date later than the forward itself is ignored', async () => {
  const subject = 'Ordered 3 items: Laptops';
  const alias = 'amazon+auto-confirm=amazon.com@alias.example.test';
  const html = headHtml('Dec 25, 2027, 10:00', alias, subject) + lines([`Order # ${ORDER}`, 'Grand Total: $1.00']);
  const r = await parseRawOrderEmail(tutaForward(subject, '', html), 'k3', { shared: true });
  assert.ok(r);
  assert.equal(r.date, '2026-11-15T22:02:15.000Z');
});

test('a plain text part that already has everything keeps being used', async () => {
  const raw = [
    'From: Amazon.com <auto-confirm@amazon.com>',
    'To: sam@orders.example.test',
    'Subject: Ordered: "Widget"',
    'Date: Sun, 15 Nov 2026 13:05:00 -0800',
    'MIME-Version: 1.0',
    'Content-Type: multipart/alternative; boundary="b2"',
    '',
    '--b2',
    'Content-Type: text/plain; charset=utf-8',
    '',
    `Order # ${ORDER}\nShip to\nSAM EXAMPLE\n100 TEST ST\nSPRINGFIELD, ZZ 00001\n\nOrder Total: $203.29`,
    '--b2',
    'Content-Type: text/html; charset=utf-8',
    '',
    `<p>Order # ${ORDER}</p><p>Order Total: $999.99</p>`,
    '--b2--',
    '',
  ].join('\r\n');
  const r = await parseRawOrderEmail(raw, 'k4', { shared: true });
  assert.ok(r);
  assert.equal(r.cost, 203.29);
  assert.equal(r.shippingAddress, 'SAM EXAMPLE, 100 TEST ST, SPRINGFIELD, ZZ 00001');
  assert.equal(r.date, '2026-11-15T21:05:00.000Z');
});

test('Costco order: the summary is raw HTML inside text/plain; the total is read, not the unit price', async () => {
  // Shape of Costco's order email: item lines as text, then the order
  // summary table as HTML markup in the same text/plain part. Synthetic numbers.
  const plain = [
    'Thank you for ordering!',
    'Your Order',
    'View order details (https://www.costco.com/OrderStatusDetailsView?orderNumber=1330000099)',
    'Brand 65&quot; Class TV (https://www.costco.com/.product.1234567.html)',
    'Brand 65&quot; Class TV (https://www.costco.com/.product.1234567.html)',
    'Item', '1234567', 'Price', '$100.00', 'Quantity', '5',
    'Order Placed', '11/17/2026', 'Membership Number', '111122223333',
    '<!--[if mso]><table><tr><td><![endif]--><!-- Container for Order Summary --><table role="presentation"><tbody>',
    '<tr><td valign="top" width="50%"><p style="margin:0">Subtotal</p></td><td align="right"><p style="margin:0">$500.00</p></td></tr>',
    '<!-- Discount on Order -->',
    '<tr><td valign="top" width="50%"><p style="margin:0">Discount on Order</p></td><td align="right"><p style="margin:0">- $80.00</p></td></tr>',
    '<!-- Shipping & Handling -->',
    '<tr><td valign="top" width="50%"><p style="margin:0">Shipping &amp; Handling</p></td><td align="right"><p style="margin:0">$0.00</p></td></tr>',
    '<!-- Final Total Row -->',
    '<tr><td valign="top" width="50%" style="padding-top:8px;border-top:1px solid #ccc"><p style="margin:0;font-weight:bold">Total</p></td><td align="right"><p style="margin:0;font-weight:bold">$420.00</p></td></tr>',
    '</tbody></table></td></tr></tbody></table><!--[if mso]></td></tr></table><![endif]-->',
    'Members Also Like', 'Patio Set', '$999.99',
  ].join('\n');
  const html = lines([
    'Thank you for ordering!', 'Brand 65&quot; Class TV', 'Item', '1234567', 'Price', '$100.00', 'Quantity', '5',
    'Subtotal', '$500.00', 'Discount on Order', '- $80.00', 'Total', '$420.00', 'Members Also Like', 'Patio Set', '$999.99',
  ]);
  const raw = [
    'From: Costco <Costco@orders.costco.com>',
    'To: sam@orders.example.test',
    'Subject: Your Costco.com Order Number 1330000099 Was Received',
    'Date: Tue, 17 Nov 2026 07:22:05 -0800',
    'MIME-Version: 1.0',
    'Content-Type: multipart/alternative; boundary="b9"',
    '',
    '--b9', 'Content-Type: text/plain; charset=utf-8', '', plain,
    '--b9', 'Content-Type: text/html; charset=utf-8', '', html,
    '--b9--', '',
  ].join('\r\n');
  const r = await parseRawOrderEmail(raw, 'k-costco', { shared: true });
  assert.ok(r);
  assert.equal(r.platform, 'Costco');
  assert.equal(r.orderNumber, '1330000099');
  assert.equal(r.cost, 420);
  assert.equal(r.itemDescription, 'Brand 65" Class TV (x5)');
});

test('buying group mail is never read as an order, even when it names a store, an order and a cancel', async () => {
  const cases = [
    { alias: 'noreply+support=buyinggroup.com@alias.example.test', sender: 'support@buyinggroup.com',
      subject: 'Here is your RECEIPT - Receipt r-1234567890 from Buying Group',
      text: 'We have received your order.> Tracking #:> 1Z999AA10123456784> Qty:> 2> Commitment:> cm-1234567890> Price:> $199.99' },
    { alias: 'deals+no-reply=mail.bfmr.com@alias.example.test', sender: 'no-reply@mail.bfmr.com',
      subject: 'Your reservation for the Amazon order was cancelled',
      text: `Your reservation was cancelled. Amazon Order # ${ORDER}` },
    { alias: 'hello+team=bigskybuyers.com@alias.example.test', sender: 'team@bigskybuyers.com',
      subject: 'Walmart order shipped: check in your package',
      text: 'Order # 2000123456789 shipped. Tracking 1Z999AA10123456784' },
  ];
  for (const c of cases) {
    const plain = head('Nov 17, 2026, 08:55', c.alias, c.subject) + `\n> ${c.text}`;
    const html = headHtml('Nov 17, 2026, 08:55', c.alias, c.subject) + '<blockquote>' + banner(c.sender) + lines([c.text]) + '</blockquote>';
    const r = await parseRawOrderEmail(tutaForward(c.subject, plain, html), 'g1', { shared: true, envelopeTo: 'sam@orders.example.test' });
    assert.equal(r, null, c.sender);
  }
});

test('a store address that only mentions a group domain is still read', async () => {
  const subject = 'Ordered: "Widget"';
  const alias = 'amazon+auto-confirm=amazon.com@alias.example.test';
  const plain = head('Nov 13, 2026, 22:30', alias, subject) + `\n> Order #> ${ORDER}> Ship to buyinggroup.com warehouse> Grand Total: $50.00`;
  const html = headHtml('Nov 13, 2026, 22:30', alias, subject) + '<blockquote>' + banner('auto-confirm@amazon.com')
    + lines([`Order # ${ORDER}`, 'Ship to buyinggroup.com warehouse', 'Grand Total: $50.00']) + '</blockquote>';
  const r = await parseRawOrderEmail(tutaForward(subject, plain, html), 'g2', { shared: true, envelopeTo: 'sam@orders.example.test' });
  assert.ok(r);
  assert.equal(r.platform, 'Amazon');
  assert.equal(r.orderNumber, ORDER);
});

test('Walmart cancellation: the item comes from the product image text, whole title and quantity', async () => {
  const html = '<html><body><p>Your delivery was canceled</p><p>Order number: 2000000-1000001</p>'
    + '<img alt="Walmart home page" src="https://img.example.test/a.png">'
    + '<img alt="quantity 2 item Acme Laptop 14 inch 2K Display Silver" src="https://img.example.test/p.png">'
    + '<p>Temporary hold released $458.00</p></body></html>';
  const raw = ['From: Walmart.com <help@walmart.com>', 'To: sam@orders.example.test', 'Subject: Canceled: delivery of Acme Laptop 14 inch... +1 item',
    'Date: Thu, 19 Nov 2026 09:00:00 -0800', 'MIME-Version: 1.0', 'Content-Type: text/html; charset=utf-8', '', html, ''].join('\r\n');
  const r = await parseRawOrderEmail(raw, 'k', { shared: true });
  assert.ok(r);
  assert.equal(r.kind, 'cancelled');
  assert.equal(r.itemDescription, 'Acme Laptop 14 inch 2K Display Silver (x2)');
});

test('Walmart delivered mail carries product images only: no delivery photo is read', async () => {
  const html = '<html><body><p>Your package arrived</p><p>Order #2000000-1000001</p><img alt="store delivery illustrator" src="https://img.example.test/s.png">'
    + '<img alt="quantity 1 item Widget Pro" src="https://img.example.test/p.png"></body></html>';
  const raw = ['From: Walmart.com <help@walmart.com>', 'To: sam@orders.example.test', 'Subject: Delivered: Widget Pro',
    'Date: Thu, 19 Nov 2026 09:00:00 -0800', 'MIME-Version: 1.0', 'Content-Type: text/html; charset=utf-8', '', html, ''].join('\r\n');
  const r = await parseRawOrderEmail(raw, 'k', { shared: true });
  assert.ok(r);
  assert.equal(r.itemDescription, 'Widget Pro');
  assert.equal(r.kind, 'delivered');
  assert.deepEqual(r.trackingNumbers, []);
});

test('multi-order Amazon email: HTML carrier links are not added to the main order', async () => {
  const A1 = '111-0000001-0000001';
  const A2 = '111-0000002-0000002';
  const html = '<html><body>'
    + `<div>1 items: Electronics</div><div>Order # ${A1}</div>`
    + `<div>3 items: Toys</div><div>Order # ${A2}</div>`
    + '<a href="https://www.example.com/progress-tracker/package?trackingId=TBA000000000009">Track package</a></body></html>';
  const raw = ['From: Amazon <shipment-tracking@amazon.com>', 'To: sam@orders.example.test', 'Subject: Shipped 4 items: Electronics, Toys',
    'Date: Thu, 19 Nov 2026 09:00:00 -0800', 'MIME-Version: 1.0', 'Content-Type: text/html; charset=utf-8', '', html, ''].join('\r\n');
  const r = await parseRawOrderEmail(raw, 'k', { shared: true });
  assert.ok(r);
  assert.equal(r.extraOrders?.length, 1);
  assert.deepEqual(r.trackingNumbers, []);
  assert.deepEqual(r.extraOrders![0].trackingNumbers, []);
});

test('single-order Amazon email: HTML carrier links still add tracking', async () => {
  const html = '<html><body><div>2 items: Electronics</div><div>Order # 111-0000001-0000001</div>'
    + '<a href="https://www.example.com/progress-tracker/package?trackingId=TBA000000000009">Track package</a></body></html>';
  const raw = ['From: Amazon <shipment-tracking@amazon.com>', 'To: sam@orders.example.test', 'Subject: Shipped: Electronics',
    'Date: Thu, 19 Nov 2026 09:00:00 -0800', 'MIME-Version: 1.0', 'Content-Type: text/html; charset=utf-8', '', html, ''].join('\r\n');
  const r = await parseRawOrderEmail(raw, 'k', { shared: true });
  assert.ok(r);
  assert.equal(r.extraOrders, undefined);
  assert.deepEqual(r.trackingNumbers, ['TBA000000000009']);
});

test('multi-order Amazon email: a split HTML part wins over a plain part with tracking and no headings', async () => {
  const A1 = '111-0000001-0000001';
  const A2 = '111-0000002-0000002';
  const plain = ['Your packages have shipped.', `Order # ${A1}`, 'Track package: TBA000000000001', `Order # ${A2}`, 'Track package: TBA000000000002'].join('\n');
  const html = '<html><body>'
    + `<div>1 items: Electronics</div><div>Order # ${A1}</div>`
    + `<div>3 items: Toys</div><div>Order # ${A2}</div></body></html>`;
  const raw = ['From: Amazon <shipment-tracking@amazon.com>', 'To: sam@orders.example.test', 'Subject: Shipped 4 items: Electronics, Toys',
    'Date: Thu, 19 Nov 2026 09:00:00 -0800', 'MIME-Version: 1.0', 'Content-Type: multipart/alternative; boundary="b1"', '',
    '--b1', 'Content-Type: text/plain; charset=utf-8', '', plain,
    '--b1', 'Content-Type: text/html; charset=utf-8', '', html, '--b1--', ''].join('\r\n');
  const r = await parseRawOrderEmail(raw, 'k', { shared: true });
  assert.ok(r);
  assert.equal(r.orderNumber, A1);
  assert.equal(r.extraOrders?.length, 1);
  assert.equal(r.extraOrders![0].orderNumber, A2);
  assert.deepEqual(r.trackingNumbers, []);
  assert.deepEqual(r.extraOrders![0].trackingNumbers, []);
});
