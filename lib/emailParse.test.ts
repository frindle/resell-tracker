import test from 'node:test';
import assert from 'node:assert/strict';
import {
  emailAddresses, stripFwdPrefix, unwrapForwarded, emailKind, itemFromSubject,
  extractOrderNumber, extractCost, extractShippingAddress, extractTrackingNumbers,
  parseOrderEmail, isOrderEmail, routeEmail, mergeEmailImportRows, htmlToText,
  unwrapReverseAlias, parseHeaderDate, itemFromBody, detectPlatform, appendExtraOrderRows,
  type EmailRowInput, plainTextWithMarkup } from './emailParse.ts';

// Synthetic fixtures only: made-up people, addresses and numbers.
const AMZ_ORDER = '111-2223334-4445556';

const amazonOrderedBody = [
  'Hello Sam,',
  'Thanks for your order. We\'ll let you know once your item(s) have dispatched.',
  `Order # ${AMZ_ORDER}`,
  'Ship to',
  'SAM EXAMPLE',
  '100 TEST ST',
  'SPRINGFIELD, ZZ 00001',
  '',
  'Item Subtotal: $189.99',
  'Shipping & Handling: $0.00',
  'Estimated tax: $13.30',
  'Order Total: $203.29',
].join('\n');

test('emailAddresses: every address, lower case, once', () => {
  assert.deepEqual(emailAddresses('Sam <Sam@Example.TEST>, b@x.test; sam@example.test'), ['sam@example.test', 'b@x.test']);
  assert.deepEqual(emailAddresses(''), []);
  assert.deepEqual(emailAddresses(null), []);
});

test('stripFwdPrefix removes stacked Fwd:/FW: prefixes only', () => {
  assert.equal(stripFwdPrefix('Fwd: FW: Ordered: "Thing"'), 'Ordered: "Thing"');
  assert.equal(stripFwdPrefix('Fw:Your order'), 'Your order');
  assert.equal(stripFwdPrefix('Forward planning'), 'Forward planning');
});

test('unwrapForwarded: Gmail forward', () => {
  const text = [
    'see below',
    '',
    '---------- Forwarded message ---------',
    'From: Amazon.com <auto-confirm@amazon.com>',
    'Date: Sat, Nov 14, 2026 at 10:00 AM',
    'Subject: Ordered: "Widget Pro" and 1 more item',
    'To: <sam.alias@relay.test>',
    '',
    '',
    amazonOrderedBody,
  ].join('\n');
  const f = unwrapForwarded(text, 'Fwd: Ordered: "Widget Pro" and 1 more item');
  assert.ok(f);
  assert.equal(f.from, 'Amazon.com <auto-confirm@amazon.com>');
  assert.equal(f.subject, 'Ordered: "Widget Pro" and 1 more item');
  assert.equal(f.to, '<sam.alias@relay.test>');
  assert.ok(f.body.startsWith('Hello Sam,'));
});

test('unwrapForwarded: Apple Mail forward with the header order changed', () => {
  const text = [
    'Begin forwarded message:',
    '',
    'From: Walmart.com <help@walmart.com>',
    'Subject: Your order has shipped',
    'Date: November 14, 2026 at 9:00:00 AM PST',
    'To: sam@example.test',
    '',
    'Order number: 2000123456789',
  ].join('\n');
  const f = unwrapForwarded(text, 'Fwd: Your order has shipped');
  assert.ok(f);
  assert.equal(f.subject, 'Your order has shipped');
  assert.equal(f.to, 'sam@example.test');
  assert.equal(f.body, 'Order number: 2000123456789');
});

test('unwrapForwarded: Outlook underscores, Sent: counts as the date, bold labels', () => {
  const text = [
    '________________________________',
    '*From:* Costco <orders@costco.com>',
    '*Sent:* Saturday, November 14, 2026 10:00 AM',
    '*To:* sam@example.test',
    '*Subject:* Your Costco.com Order Number 1234567890 Has Shipped',
    '',
    'body',
  ].join('\n');
  const f = unwrapForwarded(text, 'FW: Your Costco.com Order Number 1234567890 Has Shipped');
  assert.ok(f);
  assert.equal(f.from, 'Costco <orders@costco.com>');
  assert.equal(f.date, 'Saturday, November 14, 2026 10:00 AM');
  assert.equal(f.body, 'body');
});

test('unwrapForwarded: unknown client, Fwd subject, bare header block', () => {
  const text = ['FYI', '', 'From: Amazon.com <shipment-tracking@amazon.com>', 'Subject: Shipped: "Widget"', '', 'Your package is on the way'].join('\n');
  const f = unwrapForwarded(text, 'Fwd: Shipped: "Widget"');
  assert.ok(f);
  assert.equal(f.subject, 'Shipped: "Widget"');
  assert.equal(f.body, 'Your package is on the way');
});

test('unwrapForwarded: not a forward', () => {
  assert.equal(unwrapForwarded(amazonOrderedBody, 'Ordered: "Widget"'), null);
  // A marker with no header block under it is not a forward either.
  assert.equal(unwrapForwarded('---------- Forwarded message ---------\nhello', 'Fwd: hi'), null);
  // One From: line alone is not a header block.
  assert.equal(unwrapForwarded('From: someone\n\ntext', 'Fwd: x'), null);
});

test('emailKind from the subject, most specific first', () => {
  assert.equal(emailKind('Ordered: "Widget" and 2 more items'), 'ordered');
  assert.equal(emailKind('Your Amazon.com order #111-2223334-4445556'), 'ordered');
  assert.equal(emailKind('Thanks for your order, Sam'), 'ordered');
  assert.equal(emailKind('Shipped: "Widget"'), 'shipped');
  assert.equal(emailKind('Your order has shipped'), 'shipped');
  assert.equal(emailKind('Out for delivery: "Widget"'), 'shipped');
  assert.equal(emailKind('Delivered: "Widget"'), 'delivered');
  assert.equal(emailKind('Your order has been delivered'), 'delivered');
  assert.equal(emailKind('Your order has been cancelled'), 'cancelled');
  assert.equal(emailKind('Item canceled successfully'), 'cancelled');
  assert.equal(emailKind('Your refund for Widget'), 'refund');
  assert.equal(emailKind('Fwd: Delivered: "Widget"'), 'delivered');
  assert.equal(emailKind('Deals picked for you'), 'other');
});

test('itemFromSubject: quoted title, with the count of other items', () => {
  assert.equal(itemFromSubject('Ordered: "Widget Pro 2" and 2 more items'), 'Widget Pro 2 (+2 more)');
  assert.equal(itemFromSubject('Shipped: “Widget Pro…”'), 'Widget Pro');
  assert.equal(itemFromSubject('Fwd: Delivered: "Widget" and 1 more item'), 'Widget (+1 more)');
  assert.equal(itemFromSubject('Your order has shipped'), '');
});

test('extractOrderNumber: Amazon, Walmart, generic; generic needs a digit', () => {
  assert.equal(extractOrderNumber(`Order # ${AMZ_ORDER}`), AMZ_ORDER);
  assert.equal(extractOrderNumber('Order number: 2000123456789'), '2000123456789');
  assert.equal(extractOrderNumber('Order ID: AB12CD34'), 'AB12CD34');
  assert.equal(extractOrderNumber('Your order details are below'), '');
});

test('extractCost: grand/order total beats subtotal; fallback only for order emails', () => {
  assert.equal(extractCost(amazonOrderedBody, 'ordered'), 203.29);
  assert.equal(extractCost('Subtotal: $10.00\nTotal: $11.50', 'ordered'), 11.5);
  assert.equal(extractCost('Grand Total:\n$1,204.10', 'ordered'), 1204.1);
  assert.equal(extractCost('Widget $19.99', 'ordered'), 19.99);
  assert.equal(extractCost('Widget $19.99', 'shipped'), 0);
  assert.equal(extractCost('nothing here', 'ordered'), 0);
});

test('extractShippingAddress: "Ship to" on its own line, joined with commas', () => {
  assert.equal(extractShippingAddress(amazonOrderedBody), 'SAM EXAMPLE, 100 TEST ST, SPRINGFIELD, ZZ 00001');
  assert.equal(extractShippingAddress('Shipping to: Sam Example\n1 Main St'), 'Sam Example, 1 Main St');
  assert.equal(extractShippingAddress('no address'), '');
  // HTML mail as text: blank lines between address lines, stop at the ZIP or the next label.
  assert.equal(extractShippingAddress('Ship to:\n\nSam Example\n\n1 Main St\n\nSpringfield, ZZ 00001\n\nGrand Total: $5.00'), 'Sam Example, 1 Main St, Springfield, ZZ 00001');
  assert.equal(extractShippingAddress('Ship to:\nSam Example\nSPRINGFIELD, ZZ\nOrder Total: $5.00'), 'Sam Example, SPRINGFIELD, ZZ');
  assert.equal(extractShippingAddress('Ship to:\nSam Example\n\n\nView order'), 'Sam Example');
});

test('extractTrackingNumbers: Amazon TBA, UPS, USPS; each once', () => {
  const t = 'Track TBA123456789012 and 1z999aa10123456784, USPS 9400111899223344556677, again TBA123456789012, order 2000123456789';
  assert.deepEqual(extractTrackingNumbers(t), ['TBA123456789012', '1Z999AA10123456784', '9400111899223344556677']);
});

test('parseOrderEmail: direct Amazon order email', () => {
  const p = parseOrderEmail({
    subject: 'Ordered: "Widget Pro" and 1 more item',
    from: 'Amazon.com <auto-confirm@amazon.com>',
    text: amazonOrderedBody,
    headerLines: [
      { key: 'to', line: 'To: sam.alias@relay.test' },
      { key: 'delivered-to', line: 'Delivered-To: orders.inbox@example.test' },
      { key: 'subject', line: 'Subject: Ordered: "Widget Pro"' },
    ],
  });
  assert.equal(p.platform, 'Amazon');
  assert.equal(p.kind, 'ordered');
  assert.equal(p.forwarded, false);
  assert.equal(p.orderNumber, AMZ_ORDER);
  assert.equal(p.itemDescription, 'Widget Pro (+1 more)');
  assert.equal(p.cost, 203.29);
  assert.equal(p.shippingAddress, 'SAM EXAMPLE, 100 TEST ST, SPRINGFIELD, ZZ 00001');
  assert.deepEqual(p.trackingNumbers, []);
  assert.deepEqual(p.recipients, ['sam.alias@relay.test', 'orders.inbox@example.test']);
  assert.deepEqual(p.senders, ['auto-confirm@amazon.com']);
  assert.ok(isOrderEmail(p));
});

test('parseOrderEmail: forwarded shipped email reads the inner message', () => {
  const p = parseOrderEmail({
    subject: 'Fwd: Shipped: "Widget Pro"',
    from: 'Sam <sam@example.test>',
    text: [
      '---------- Forwarded message ---------',
      'From: Amazon.com <shipment-tracking@amazon.com>',
      'Date: Sat, Nov 14, 2026 at 10:00 AM',
      'Subject: Shipped: "Widget Pro"',
      'To: <sam.alias@relay.test>',
      '',
      `Order # ${AMZ_ORDER}`,
      'Tracking number TBA123456789012',
      'Item price $189.99',
    ].join('\n'),
    headerLines: [{ key: 'to', line: 'To: orders.inbox@example.test' }],
  });
  assert.equal(p.forwarded, true);
  assert.equal(p.platform, 'Amazon');
  assert.equal(p.kind, 'shipped');
  assert.equal(p.subject, 'Shipped: "Widget Pro"');
  assert.equal(p.orderNumber, AMZ_ORDER);
  assert.equal(p.cost, 0);
  assert.deepEqual(p.trackingNumbers, ['TBA123456789012']);
  assert.deepEqual(p.recipients, ['orders.inbox@example.test', 'sam@example.test', 'sam.alias@relay.test']);
  assert.deepEqual(p.senders, ['shipment-tracking@amazon.com']);
});

test('isOrderEmail: needs a known retailer or an order number', () => {
  assert.ok(!isOrderEmail({ platform: 'Unknown', orderNumber: '' }));
  assert.ok(isOrderEmail({ platform: 'Unknown', orderNumber: '2000123456789' }));
});

const rules = [
  { userId: 1, pattern: 'sam@example.test' },
  { userId: 1, pattern: 'sam.alias@relay.test' },
  { userId: 2, pattern: 'lee@example.test' },
  { userId: 2, pattern: 'amazon.com' },
];

test('routeEmail: the address it was sent to or forwarded from decides', () => {
  assert.deepEqual(
    routeEmail(rules, { recipients: ['orders.inbox@example.test', 'sam@example.test'], senders: ['auto-confirm@amazon.com'] }, { inboxAddress: 'orders.inbox@example.test' }),
    { userId: 1, via: 'recipient' },
  );
});

test('routeEmail: the retailer address only counts when no recipient matches', () => {
  assert.deepEqual(
    routeEmail(rules, { recipients: ['orders.inbox@example.test'], senders: ['auto-confirm@amazon.com'] }, { inboxAddress: 'orders.inbox@example.test' }),
    { userId: 2, via: 'sender' },
  );
});

test('routeEmail: the shared inbox itself never matches a rule', () => {
  const r = [{ userId: 3, pattern: 'example.test' }];
  assert.deepEqual(
    routeEmail(r, { recipients: ['orders.inbox@example.test'], senders: ['x@shop.test'] }, { inboxAddress: 'Orders.Inbox@example.test' }),
    { userId: null, via: 'none' },
  );
});

test('routeEmail: two users on the same tier is ambiguous', () => {
  assert.deepEqual(
    routeEmail(rules, { recipients: ['sam@example.test', 'lee@example.test'], senders: [] }),
    { userId: null, via: 'ambiguous' },
  );
});

test('routeEmail: a single-user tracker takes everything; blank patterns never match', () => {
  assert.deepEqual(routeEmail([], { recipients: [], senders: [] }, { onlyUserId: 7 }), { userId: 7, via: 'only-user' });
  assert.deepEqual(routeEmail([{ userId: 1, pattern: '  ' }], { recipients: ['a@b.test'], senders: [] }), { userId: null, via: 'none' });
});

const base = (over: Partial<EmailRowInput>): EmailRowInput => ({
  platform: 'Amazon', orderNumber: AMZ_ORDER, orderDate: '2026-11-14T18:00:00.000Z', itemDescription: '',
  cost: 0, shippingCost: 0, salePrice: null, buyerId: '', cardId: '', cashbackAmount: 0,
  shippingAddress: '', trackingNumbers: [], kind: 'ordered', ...over,
});

test('mergeEmailImportRows: ordered + shipped for one order become one row', () => {
  const { rows, dropped } = mergeEmailImportRows([
    base({ kind: 'shipped', orderDate: '2026-11-15T18:00:00.000Z', trackingNumbers: ['TBA123456789012'], itemDescription: 'Widget' }),
    base({ kind: 'ordered', cost: 203.29, cashbackAmount: 10.16, shippingAddress: 'SAM, 100 TEST ST', buyerId: '4', cardId: '2' }),
  ]);
  assert.equal(dropped, 0);
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.cost, 203.29);
  assert.equal(r.cashbackAmount, 10.16);
  assert.equal(r.orderDate, '2026-11-14T18:00:00.000Z');
  assert.equal(r.itemDescription, 'Widget');
  assert.equal(r.shippingAddress, 'SAM, 100 TEST ST');
  assert.equal(r.buyerId, '4');
  assert.deepEqual(r.trackingNumbers, ['TBA123456789012']);
  assert.equal(r.updateOnly, undefined);
  assert.equal(r.cancelled, undefined);
});

test('mergeEmailImportRows: no order email means update-only; cancel carries through', () => {
  const { rows } = mergeEmailImportRows([
    base({ kind: 'delivered', cost: 5 }),
    base({ orderNumber: '2000123456789', platform: 'Walmart', kind: 'ordered', cost: 50 }),
    base({ orderNumber: '2000-1234-56789', platform: 'Walmart', kind: 'cancelled' }),
  ]);
  assert.equal(rows.length, 2);
  const amz = rows.find(r => r.platform === 'Amazon')!;
  assert.equal(amz.updateOnly, true);
  assert.equal(amz.cost, 0);
  const wm = rows.find(r => r.platform === 'Walmart')!;
  assert.equal(wm.cancelled, true);
  assert.equal(wm.updateOnly, undefined);
  assert.equal(wm.cost, 50);
});

test('mergeEmailImportRows: no order number keeps order emails, drops the rest', () => {
  const { rows, dropped } = mergeEmailImportRows([
    base({ orderNumber: '', kind: 'ordered', cost: 9.99 }),
    base({ orderNumber: '', kind: 'ordered', cost: 19.99 }),
    base({ orderNumber: '', kind: 'shipped' }),
  ]);
  assert.equal(rows.length, 2);
  assert.equal(dropped, 1);
});

test('htmlToText: block tags to lines, entities decoded, scripts dropped', () => {
  const html = '<html><head><style>p{}</style></head><body><p>Order&nbsp;Total:</p><div>&#36;12.34 &amp; more</div><script>x()</script><table><tr><td>Ship to</td><td>SAM</td></tr></table></body></html>';
  assert.equal(htmlToText(html), 'Order Total:\n$12.34 & more\nShip to SAM');
});

// --- Tuta forwards, addy.io aliases, Lenovo -------------------------------

test('unwrapReverseAlias: addy.io alias+local=domain@alias-domain is the real sender', () => {
  assert.equal(unwrapReverseAlias('amazon+auto-confirm=amazon.com@alias.example.test'), 'auto-confirm@amazon.com');
  assert.equal(unwrapReverseAlias('"Amazon \'auto-confirm at amazon.com\'" <amazon+auto-confirm=amazon.com@alias.example.test>'),
    '"Amazon \'auto-confirm at amazon.com\'" <auto-confirm@amazon.com>');
  assert.equal(unwrapReverseAlias('lenovo+lenovomail=lenovo.com@alias.example.test'), 'lenovomail@lenovo.com');
  assert.equal(unwrapReverseAlias('sam+shop@example.test'), 'sam+shop@example.test');
});

test('parseHeaderDate: Tuta, Gmail and RFC 2822 forms; junk is null', () => {
  assert.equal(parseHeaderDate('Nov 13, 2026, 22:30')?.getTime(), new Date(2026, 10, 13, 22, 30).getTime());
  assert.equal(parseHeaderDate('Fri, Nov 13, 2026 at 10:30 PM')?.getTime(), new Date(2026, 10, 13, 22, 30).getTime());
  assert.equal(parseHeaderDate('Fri, 13 Nov 2026 22:30:00 +0000')?.toISOString(), '2026-11-13T22:30:00.000Z');
  assert.equal(parseHeaderDate(''), null);
  assert.equal(parseHeaderDate('not a date'), null);
});

test('unwrapForwarded: Tuta puts Date above From with no marker line', () => {
  const text = [
    'Date: Nov 13, 2026, 22:30',
    'From: amazon+auto-confirm=amazon.com@alias.example.test',
    'To: amazon@alias.example.test',
    'Subject: Ordered 3 items: Laptops',
    'To: amazon@alias.example.test (Created automatically by catch-all)',
    'From: auto-confirm@amazon.com',
    'Actions: Deactivate | Block email | Block domain',
    'Removed 5 tracking pixels - View report',
    'Arriving Tuesday',
  ].join('\n');
  const f = unwrapForwarded(text, 'FWD: Ordered 3 items: Laptops');
  assert.ok(f);
  assert.equal(f.date, 'Nov 13, 2026, 22:30');
  assert.equal(f.from, 'amazon+auto-confirm=amazon.com@alias.example.test');
  assert.equal(f.subject, 'Ordered 3 items: Laptops');

  const p = parseOrderEmail({ subject: 'FWD: Ordered 3 items: Laptops', from: 'Sam <sam@home.example.test>', text });
  assert.equal(p.from, 'auto-confirm@amazon.com');
  assert.deepEqual(p.senders, ['auto-confirm@amazon.com']);
  assert.equal(p.date, 'Nov 13, 2026, 22:30');
  assert.equal(p.body, 'Arriving Tuesday', 'addy banner stripped');
});

test('itemFromSubject: Amazon "Ordered N items: Name"', () => {
  assert.equal(itemFromSubject('FWD: Ordered 3 items: Laptops'), 'Laptops (3 items)');
  assert.equal(itemFromSubject('Ordered 1 item: Echo Dot'), 'Echo Dot (1 items)');
  assert.equal(itemFromSubject('Your order has shipped'), '');
});

const lenovoBody = [
  'Thank you for your order!',
  'Order Number: K100200300',
  'Order Placed: 11/15/2026',
  'Sam,',
  'Our standard order delivery date is 4-9 days after Lenovo ships your product.',
  'Your order summary:',
  'ITEM', 'DELIVERY METHOD', 'QTY', 'TOTAL PRICE',
  'Yoga 7 2-in-1 (14″ AMD)', '83JR0003US', 'Get it by Thu. Nov 19', '1', '$767.12',
  'Billing Details:', '100 Test St', 'Springfield', 'US-ZZ', '00001-0001', 'United States of America', 'Card Payment',
  'Shipping Details:', '100 Test St', 'Springfield', 'US-ZZ', '00001-0001', 'United States of America',
  'Sub total:', '$1,599.99', 'Instant Savings:', '-$750.00', 'Tax:', '$0.00', 'Shipping:', 'FREE', 'Total:', '$767.12',
  'Still shopping? You might be interested in:', 'ThinkPad Hybrid USB-C', '$309.99',
].join('\n');

test('Lenovo: platform, order number, item table, shipping details, total not sub total', () => {
  assert.equal(detectPlatform('lenovomail@lenovo.com', 'Thank you for your order!'), 'Lenovo');
  assert.equal(detectPlatform('x@example.test', 'Ordered: "Lenovo Yoga"'), 'Unknown');
  assert.equal(extractOrderNumber(lenovoBody), 'K100200300');
  assert.equal(itemFromBody('Lenovo', lenovoBody), 'Yoga 7 2-in-1 (14″ AMD)');
  assert.equal(itemFromBody('Amazon', lenovoBody), '');
  const two = lenovoBody.replace('$767.12\nBilling', () => '$767.12\nIdeaPad Slim 5\n82XF\nStandard\n2\n$1,000.00\nBilling');
  assert.equal(itemFromBody('Lenovo', two), 'Yoga 7 2-in-1 (14″ AMD) (+1 more)');
  assert.equal(itemFromBody('Lenovo', 'TOTAL PRICE\nWidget\nW1\nStandard\n3\n$9.00\nBilling Details:'), 'Widget (x3)');
  assert.equal(extractShippingAddress(lenovoBody), '100 Test St, Springfield, US-ZZ, 00001-0001');
  assert.equal(extractCost(lenovoBody, 'ordered'), 767.12);
  assert.equal(extractCost('Sub-total: $10.00\nTotal: $12.00', 'shipped'), 12);

  const p = parseOrderEmail({ subject: 'Thank you for your order!', from: 'Lenovo <lenovomail@lenovo.com>', text: lenovoBody });
  assert.equal(p.platform, 'Lenovo');
  assert.equal(p.kind, 'ordered');
  assert.equal(p.itemDescription, 'Yoga 7 2-in-1 (14″ AMD)');
  assert.equal(p.cost, 767.12);
  assert.ok(isOrderEmail(p));
});

test('extractShippingAddress: Amazon\'s unlabelled "Name - City, ST" above Order #', () => {
  const body = 'Arriving Tuesday\n3 Laptops\nSam - springfield, ZZ\nOrder # \u202B111-2223334-4445556\nView or edit order\nGrand Total: $899.97';
  assert.equal(extractShippingAddress(body), 'Sam - springfield, ZZ');
  assert.equal(extractShippingAddress('Thanks - see you soon, OK\nnothing here'), '');
  // A labelled block still wins.
  assert.equal(extractShippingAddress(`Ship to\nSAM EXAMPLE\n1 MAIN ST\nSPRINGFIELD, ZZ 00001\nSam - springfield, ZZ\nOrder # 1`), 'SAM EXAMPLE, 1 MAIN ST, SPRINGFIELD, ZZ 00001');
});

test('extractShippingAddress: Walmart\'s unlabelled one-line address', () => {
  const body = '> We\'ll let you know when it\'s on the way.\n> Arrives Mon, Nov 16\n>    >  >\n> 100 Test St, Unit 4, Springfield, ZZ, 00001, USA\n>    >  >\n> 2 items  > See all\n> Order total > $898.00';
  assert.equal(extractShippingAddress(body), '100 Test St, Unit 4, Springfield, ZZ, 00001, USA');
  assert.equal(extractShippingAddress('100 Test St, Springfield, ZZ 00001'), '100 Test St, Springfield, ZZ 00001');
  // Needs a house number, a state and a ZIP on the same line.
  assert.equal(extractShippingAddress('Save 20%, today only, on 2 items, CA, 90210 deals'), '');
  assert.equal(extractShippingAddress('Main St, Springfield, ZZ, 00001'), '');
  assert.equal(extractShippingAddress('Order 12345, shipped, ZZ'), '');
});

test('itemFromBody: Costco item table with soft-hyphen padding', () => {
  const SH = '­';
  const body = [
    'Your Order', 'View order details for detailed shipping info.',
    'Gift Brand - Two $50 eGift Cards', 'Item', `${SH}1234567${SH}`, 'Price', `${SH}$79.99${SH}`, 'Quantity', '2',
    'Order Placed', '11/14/2026', 'Subtotal', '$159.98', 'Total', '$159.98',
    'Members Also Like', 'Some Bathtub', 'Starting at $829.99',
  ].join('\n');
  assert.equal(itemFromBody('Costco', body), 'Gift Brand - Two $50 eGift Cards (x2)');
  const two = body.replace('Order Placed', 'Other Card Pack\nItem\n7654321\nPrice\n$24.99\nQuantity\n1\nOrder Placed');
  assert.equal(itemFromBody('Costco', two), 'Gift Brand - Two $50 eGift Cards (x2) (+1 more)');
  assert.equal(itemFromBody('Costco', 'Item\nnot a number\nPrice'), '');
  assert.equal(itemFromBody('Amazon', body), '');
});

test('itemFromBody: Costco name with its product link and an HTML entity', () => {
  const body = ['Brand 65&quot; Class TV (https://www.costco.com/.product.1234567.html)', 'Item', '1234567', 'Price', '$100.00', 'Quantity', '5'].join('\n');
  assert.equal(itemFromBody('Costco', body), 'Brand 65" Class TV (x5)');
});

test('plainTextWithMarkup: reads table markup, keeps plain text and forwarded addresses', () => {
  const plain = 'From: Shop <orders@shop.example.test>\nTotal is below';
  assert.equal(plainTextWithMarkup(plain), plain);
  const mixed = `${plain}\n<!-- Final Total Row --><table><tr><td><p>Total</p></td><td><p>&#36;420.00</p></td></tr></table>`;
  const out = plainTextWithMarkup(mixed);
  assert.match(out, /<orders@shop\.example\.test>/);
  assert.match(out, /^Total\s*\n?\s*\$420\.00$/m);
  assert.doesNotMatch(out, /<\/?(?:table|td|p)\b|Final Total Row/);
});

test('emailKind: Costco gift notice is not an order email', () => {
  assert.equal(emailKind('Costco.com - Manage Your Order 1330778847'), 'other');
  assert.equal(emailKind('Your Costco.com order 1330778847 is confirmed!'), 'ordered');
});

test('mergeEmailImportRows: a $0 ordered notice does not hide the real total', () => {
  const base = { platform: 'Costco', orderNumber: '1330000001', orderDate: '2026-11-14', itemDescription: '', cost: 0, shippingCost: 0, salePrice: null, buyerId: '', cardId: '', cashbackAmount: 0, kind: 'ordered' as const };
  const { rows } = mergeEmailImportRows([base, { ...base, cost: 159.98, itemDescription: 'Pack (x2)' }]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].cost, 159.98);
  assert.equal(rows[0].itemDescription, 'Pack (x2)');
  assert.equal(rows[0].updateOnly, undefined);
});

test('every email is read for tracking; "arriving" is a shipping note', async () => {
  const { parseOrderEmail, emailKind } = await import('./emailParse.ts');
  assert.equal(emailKind('Your order K000000001 is arriving soon'), 'shipped');
  const p = parseOrderEmail({ subject: 'Your order K000000001 is arriving soon', from: 'no-reply@lenovo.com', text: 'Hi,\nYour order is on track for delivery tomorrow.\nTracking Number:\n1Z999AA10123456784\n' });
  assert.deepEqual(p.trackingNumbers, ['1Z999AA10123456784']);
  assert.equal(p.orderNumber, 'K000000001');
  // "delivery tomorrow" is not a "delivery to" label.
  assert.equal(p.shippingAddress, '');
  // An order confirmation that already carries tracking keeps it.
  const ordered = parseOrderEmail({ subject: 'Thanks for your order', from: 'orders@store.test', text: 'Order number: 5550001234\nTracking 1Z999AA10123456784\nTotal: $10.00' });
  assert.equal(ordered.kind, 'ordered');
  assert.deepEqual(ordered.trackingNumbers, ['1Z999AA10123456784']);
  // A refund's tracking is a return label, not the order's shipment.
  const refund = parseOrderEmail({ subject: 'Your refund', from: 'returns@store.test', text: 'Order number: 5550001234\nReturn label 1Z999AA10123456784' });
  assert.deepEqual(refund.trackingNumbers, []);
});

test('order numbers and tracking from links', async () => {
  const { orderNumberFromLinks, trackingFromLinks } = await import('./emailParse.ts');
  assert.equal(orderNumberFromLinks('<https://lenovous.aftership.com/order-status?email=a%40b.test&order-number=K000000001&lang=en>'), 'K000000001');
  assert.equal(orderNumberFromLinks(`<a href="https://www.lenovo.com/us/en/order/lookup/detail.html?orderNumber=${'ab12'.repeat(32)}&amp;x=1">`), '');
  assert.deepEqual(trackingFromLinks('<a href="https://www.ups.com/track?tracknum=1Z999AA10123456784&amp;loc=en_US">Track</a>'), ['1Z999AA10123456784']);
  // A long number in a pixel or promo link is not tracking.
  assert.deepEqual(trackingFromLinks('<img src="https://pixel.store.test/o?id=91234567890123456789012">'), []);
  const { parseOrderEmail } = await import('./emailParse.ts');
  const promo = parseOrderEmail({ subject: 'Thanks for your order', from: 'orders@store.test', text: 'Order number: 5550001234\n<https://click.store.test/c?id=91234567890123456789012>\nTotal: $10.00' });
  assert.deepEqual(promo.trackingNumbers, []);
});

test('cancelDetails: released amount and whole-order wording', async () => {
  const { parseOrderEmail } = await import('./emailParse.ts');
  const wm = parseOrderEmail({ subject: 'Canceled: Laptop +1 item from delivery', from: 'help@walmart.com', text: 'Order number: 2000000-00000001\nSome items were canceled\n2 items canceled\nLaptop\nQty: 2\nTemporary hold released\nVISA ending in 0000\n$898.00\n' });
  assert.equal(wm.kind, 'cancelled');
  assert.deepEqual(wm.cancel, { amount: 898, whole: false });
  const amz = parseOrderEmail({ subject: '2 items cancelled successfully: Consoles', from: 'auto-confirm@amazon.com', text: 'Your items were cancelled\nYour order was cancelled. You have not been charged for this order.\nOrder #\n111-2223334-4445556\n' });
  assert.deepEqual(amz.cancel, { amount: 0, whole: true });
  assert.deepEqual(amz.trackingNumbers, []);
  const part = parseOrderEmail({ subject: 'Item canceled', from: 'auto-confirm@amazon.com', text: 'Your order has been cancelled for some items. The remaining items will still ship.\nRefund total: $25.00' });
  assert.deepEqual(part.cancel, { amount: 25, whole: false });
});

// FedEx numbers are bare digits, so they need proof: a FedEx link, or a
// "tracking"/"FedEx" label in an email that says FedEx, plus the check digit.
// 123456789012 and 986578788855 have valid check digits; 123456789013 does not.
test('fedex12CheckDigitOk: FedEx check digit', async () => {
  const { fedex12CheckDigitOk } = await import('./carrier.ts');
  for (const n of ['986578788855', '477179081230', '799531274483', '123456789012']) assert.ok(fedex12CheckDigitOk(n), n);
  for (const n of ['123456789013', '98657878885', '9865787888550', 'TBA123456789']) assert.ok(!fedex12CheckDigitOk(n), n);
});

test('fedexFromLinks: tracking params and /fedex/ paths on FedEx links only', async () => {
  const { fedexFromLinks } = await import('./emailParse.ts');
  assert.deepEqual(fedexFromLinks('<a href="https://www.fedex.com/fedextrack/?trknbr=123456789012&amp;trkqual=x">Track</a>'), ['123456789012']);
  assert.deepEqual(fedexFromLinks('https://store.narvar.test/store/tracking/fedex?tracking_numbers=123456789012%2C986578788855&order=1'), ['123456789012', '986578788855']);
  assert.deepEqual(fedexFromLinks('https://shop.aftership.test/fedex/123456789012?page-name=tracking'), ['123456789012']);
  assert.deepEqual(fedexFromLinks('https://www.fedex.com/apps/fedextrack/?action=track&tracknumbers=012345678901234'), ['012345678901234']);
  // Not FedEx, or not a tracking field.
  assert.deepEqual(fedexFromLinks('https://www.ups.com/track?tracknum=123456789012'), []);
  assert.deepEqual(fedexFromLinks('https://www.fedex.com/en-us/home.html?cid=123456789012'), []);
});

test('fedexFromText: a labelled number in an email that says FedEx', async () => {
  const { fedexFromText } = await import('./emailParse.ts');
  assert.deepEqual(fedexFromText('Shipped with FedEx\nTracking number: 123456789012'), ['123456789012']);
  assert.deepEqual(fedexFromText('FedEx tracking # 1234 5678 9012'), ['123456789012']);
  assert.deepEqual(fedexFromText('Your FedEx shipment 986578788855 is on its way'), ['986578788855']);
  assert.deepEqual(fedexFromText('Carrier: FedEx Ground\nTracking: 012345678901234'), ['012345678901234']);
});

test('fedexFromText: order, phone, account and unlabelled numbers are not tracking', async () => {
  const { fedexFromText } = await import('./emailParse.ts');
  // No FedEx anywhere: a bare 12-digit number could be anything.
  assert.deepEqual(fedexFromText('Tracking number: 123456789012'), []);
  // Wrong check digit.
  assert.deepEqual(fedexFromText('FedEx\nTracking number: 123456789013'), []);
  // The order's own number, given or labelled elsewhere in the email.
  assert.deepEqual(fedexFromText('Shipped via FedEx. Tracking: 200012345678901', '200012345678901'), []);
  assert.deepEqual(fedexFromText('Order # 200012345678901\nShipped via FedEx\nTracking: 200012345678901'), []);
  // An order or account label between the label and the number.
  assert.deepEqual(fedexFromText('Shipped via FedEx\nTrack your order 200012345678901'), []);
  assert.deepEqual(fedexFromText('FedEx account 123456789012'), []);
  // Dashed numbers: phone lines and store order ids like BBY01-123456789012.
  assert.deepEqual(fedexFromText('Questions? Call FedEx 1-800-463-3339'), []);
  assert.deepEqual(fedexFromText('FedEx tracking BBY01-123456789012'), []);
  // A number in a sentence after the label, not the first number.
  assert.deepEqual(fedexFromText('Shipped by FedEx on 11/15. Order 123456789012'), []);
});

test('parseOrderEmail: store shipping email with a FedEx number', () => {
  const p = parseOrderEmail({
    subject: 'Your order has shipped',
    from: 'Store <orders@store.test>',
    text: [
      'Order number: 200012345678901',
      'Carrier: FedEx',
      'Tracking Number: 123456789012',
      'Track it: https://www.fedex.com/fedextrack/?trknbr=986578788855',
    ].join('\n'),
  });
  assert.equal(p.kind, 'shipped');
  assert.equal(p.orderNumber, '200012345678901');
  assert.deepEqual([...p.trackingNumbers].sort(), ['123456789012', '986578788855']);
});

test('parseOrderEmail: a refund email\'s FedEx return label is not the order\'s tracking', () => {
  const p = parseOrderEmail({
    subject: 'Your refund has been issued',
    from: 'Store <orders@store.test>',
    text: 'Order number: 200012345678901\nReturn shipped with FedEx\nTracking Number: 123456789012',
  });
  assert.deepEqual(p.trackingNumbers, []);
});

// --- cancellation items, multi-order Amazon shipments (synthetic) ---

test('cancellation subjects name the item', async () => {
  const { itemFromCancelSubject, itemFromImageAlts } = await import('./emailParse.ts');
  assert.equal(itemFromSubject('Canceled: delivery of Acme Laptop 14-inch HD... +1 item'), 'Acme Laptop 14-inch HD (+1 more)');
  assert.equal(itemFromSubject('Canceled: Widget Pro 15.6-inch... +1 item'), 'Widget Pro 15.6-inch (+1 more)');
  assert.equal(itemFromSubject('FWD: 2 items cancelled successfully: Gaming Consoles'), 'Gaming Consoles (2 items)');
  assert.equal(itemFromCancelSubject('Canceled: delivery of Solo Gadget'), 'Solo Gadget');
  assert.equal(itemFromCancelSubject('Your order was canceled'), '');
  assert.equal(
    itemFromImageAlts('<img alt="Walmart home page" src="a"><img src="b" alt="quantity 2 item Acme Laptop 14 inch 2K Display"><img alt="Payment Card image">'),
    'Acme Laptop 14 inch 2K Display (x2)',
  );
  assert.equal(itemFromImageAlts('<img alt="item image" src="x">'), '');
});

const A1 = '111-0000001-0000001';
const A2 = '111-0000002-0000002';
const A3 = '111-0000003-0000003';
const multiShipBody = [
  'Sam, your package was shipped!',
  '3 items: 2 Wearable Technology, 1 Electronics',
  'Sam - Springfield, ZZ',
  `Order # ‫${A1}`,
  'Track package https://www.example.com/progress-tracker/package?orderId=' + A1,
  '1 items: Electronics',
  'Sam - Springfield, ZZ',
  `Order # ‫${A2}`,
  'Track package TBA000000000001',
  '4 items: 4 Wearable Technology',
  'Sam - Springfield, ZZ',
  `Order # ‫${A3}`,
  'Track package https://www.example.com/progress-tracker/package?orderId=' + A3,
  'Total $100.00',
].join('\n');

test('one Amazon shipment email covering three orders: every order gets its own items, none gets tracking', () => {
  const p = parseOrderEmail({ subject: 'Shipped 8 items: Wearable Technology, Electronics', from: 'shipment-tracking@amazon.com', text: multiShipBody });
  assert.equal(p.kind, 'shipped');
  assert.equal(p.orderNumber, A1);
  assert.equal(p.itemDescription, 'Wearable Technology, Electronics (3 items)');
  assert.deepEqual(p.trackingNumbers, []);
  assert.deepEqual(p.extraOrders, [
    { orderNumber: A2, itemDescription: 'Electronics (1 items)', trackingNumbers: [] },
    { orderNumber: A3, itemDescription: 'Wearable Technology (4 items)', trackingNumbers: [] },
  ]);
});

test('a single-order Amazon shipment is read as before', () => {
  const p = parseOrderEmail({ subject: 'Shipped 2 items: Gaming Consoles', from: 'shipment-tracking@amazon.com', text: `2 Gaming Consoles\nSam - Springfield, ZZ\nOrder # ${A1}\nTrack package` });
  assert.equal(p.orderNumber, A1);
  assert.equal(p.extraOrders, undefined);
});

// --- multi-order safety: wrong tracking is worse than none (synthetic) ---

const shipSubject = 'Shipped 4 items: Electronics, Toys';
const shipFrom = 'shipment-tracking@amazon.com';

test('multi-order split: tracking printed above "Order #" lands on no order', () => {
  const body = [
    '1 items: Electronics', 'Sam - Springfield, ZZ', 'Track package TBA000000000001', `Order # ${A1}`,
    '3 items: Toys', 'Sam - Springfield, ZZ', 'Track package TBA000000000002', `Order # ${A2}`,
  ].join('\n');
  const p = parseOrderEmail({ subject: shipSubject, from: shipFrom, text: body });
  assert.equal(p.extraOrders?.length, 1);
  assert.deepEqual(p.trackingNumbers, []);
  assert.deepEqual(p.extraOrders![0].trackingNumbers, []);
});

test('multi-order split: a FedEx link in another order block does not reach the main order', () => {
  const body = [
    '1 items: Electronics', `Order # ${A1}`,
    '3 items: Toys', `Order # ${A2}`,
    'Track: https://www.fedex.com/fedextrack/?trknbr=123456789012',
  ].join('\n');
  const p = parseOrderEmail({ subject: shipSubject, from: shipFrom, text: body });
  assert.equal(p.extraOrders?.length, 1);
  assert.deepEqual(p.trackingNumbers, []);
  assert.deepEqual(p.extraOrders![0].trackingNumbers, []);
});

test('multi-order split: a summary line listing every order number is not a split by itself', () => {
  const body = [`Your orders ${A1} and ${A2} shipped`, '1 items: Electronics', `Order # ${A1}`, 'Track package TBA000000000001'].join('\n');
  const p = parseOrderEmail({ subject: shipSubject, from: shipFrom, text: body });
  assert.equal(p.extraOrders, undefined);
});

test('a repeated order number is one order, not a split', () => {
  const body = ['2 items: Electronics', `Order # ${A1}`, 'Track package TBA000000000001', `Order # ${A1}`].join('\n');
  const p = parseOrderEmail({ subject: shipSubject, from: shipFrom, text: body });
  assert.equal(p.extraOrders, undefined);
  assert.deepEqual(p.trackingNumbers, ['TBA000000000001']);
});

test('a second order number with no item heading (a footer) does not split the email', () => {
  const body = ['2 items: Electronics', 'Sam - Springfield, ZZ', `Order # ${A1}`, 'Track package TBA000000000001', 'Your recent order', `Order # ${A2}`].join('\n');
  const p = parseOrderEmail({ subject: shipSubject, from: shipFrom, text: body });
  assert.equal(p.extraOrders, undefined);
  assert.equal(p.orderNumber, A1);
  assert.deepEqual(p.trackingNumbers, ['TBA000000000001']);
});

test('cancellation subject: 2,000 spaces parse fast, and "Order #" is not an item', async () => {
  const { itemFromCancelSubject } = await import('./emailParse.ts');
  const t = performance.now();
  assert.equal(itemFromCancelSubject(`Canceled: x${' '.repeat(2000)}`), '');
  assert.equal(itemFromCancelSubject(`Canceled: Widget${' '.repeat(2000)}...`), 'Widget');
  assert.ok(performance.now() - t < 50);
  assert.equal(itemFromCancelSubject('Canceled: Order #123456'), '');
  assert.equal(itemFromCancelSubject('Canceled: your order has been canceled'), '');
});

test('image alt scan is bounded on an unclosed <img', async () => {
  const { itemFromImageAlts } = await import('./emailParse.ts');
  const t = performance.now();
  assert.equal(itemFromImageAlts('<img '.repeat(20000)), '');
  // Catastrophic backtracking takes seconds; a loaded machine takes a fraction of this.
  assert.ok(performance.now() - t < 1000);
});

test('appendExtraOrderRows: extra orders get their own rows, cancels and repeats add none', () => {
  const base: EmailRowInput = {
    kind: 'shipped', platform: 'Amazon', orderNumber: '111-0000001-0000001', orderDate: '2026-11-19', itemDescription: 'Electronics',
    cost: 20, shippingCost: 0, salePrice: 30, buyerId: '4', cardId: 'c1', cashbackAmount: 1, shippingAddress: '1 Example St', trackingNumbers: [],
  };
  const extras = [
    { orderNumber: '111-0000002-0000002', itemDescription: 'Toys', trackingNumbers: [] },
    { orderNumber: '111-0000001-0000001', itemDescription: 'dup', trackingNumbers: [] },
    { orderNumber: '  ', itemDescription: 'blank', trackingNumbers: [] },
  ];
  const out = appendExtraOrderRows([base], [{ kind: 'shipped', extraOrders: extras }]);
  assert.equal(out.length, 2);
  assert.equal(out[0], base);
  assert.equal(out[1].orderNumber, '111-0000002-0000002');
  assert.equal(out[1].itemDescription, 'Toys');
  assert.equal(out[1].cost, 0);
  assert.equal(out[1].salePrice, null);
  assert.equal(out[1].cardId, '');
  assert.equal(out[1].buyerId, '4');
  assert.equal(out[1].kind, 'shipped');
  assert.equal(appendExtraOrderRows([base], [{ kind: 'cancelled', extraOrders: extras }]).length, 1);
  assert.equal(appendExtraOrderRows([base], [{ kind: 'shipped' }]).length, 1);
});
