import { test } from 'node:test';
import assert from 'node:assert/strict';
import { senderDomain, redactForTriage, parseTriageResult, matchesIgnoreRule, normalizeDomain, safeIgnoreRule, submitErrorKind, triageRef, triageDigestLine, TRIAGE_SYSTEM } from './inboxTriage.ts';
import { lineLooksPrivate, MAX_LINE_CHARS } from './digestPrivate.ts';

const redact = (text: string, subject = '') => redactForTriage({ fromDomain: 'shop.example.com', subject, text });
const body = (out: string) => out.slice(out.indexOf('\n\n') + 2);

test('senderDomain reads the address in a display-name header', () => {
  assert.equal(senderDomain('Klarna <no-reply@klarna.com>'), 'klarna.com');
  assert.equal(senderDomain('"Pat Example" <Pat@Mail.Example.COM>'), 'mail.example.com');
  assert.equal(senderDomain('bills@example.com'), 'example.com');
  assert.equal(senderDomain('no address here'), '');
  assert.equal(senderDomain(''), '');
});

test('the redacted message starts with the domain and subject', () => {
  assert.equal(redactForTriage({ fromDomain: 'klarna.com', subject: 'Your statement', text: 'Hello' }), 'From domain: klarna.com\nSubject: Your statement\n\nHello');
});

test('email addresses become [email], in the subject too', () => {
  const out = redact('Write to jane.doe@example.com now', 'Re: jane@example.com');
  assert.equal(body(out), 'Write to [email] now');
  assert.ok(out.includes('Subject: Re: [email]\n'));
});

test('links become [link domain] and keep the sentence punctuation', () => {
  assert.equal(body(redact('See https://www.example.com/track?id=1 today.')), 'See [link example.com] today.');
  assert.equal(body(redact('Visit https://example.com/a.')), 'Visit [link example.com].');
});

test('phone numbers become [phone]', () => {
  assert.equal(body(redact('Call (555) 123-4567 or 555-987-6543.')), 'Call [phone] or [phone].');
});

test('runs of six or more digits become [number], with spaces or dashes inside', () => {
  assert.equal(body(redact('Order 123456 and 4111 1111 1111 1111 code 99-88-77.')), 'Order [number] and [number] code [number].');
  assert.equal(body(redact('Order 12345 is small')), 'Order 12345 is small');
});

test('a line that starts like a street address becomes [address]', () => {
  assert.equal(body(redact('Ship to:\n123 Main St\nApt 4')), 'Ship to: [address] Apt 4');
  assert.equal(body(redact('1600 Pennsylvania Ave NW\nWashington')), '[address] Washington');
  assert.equal(body(redact('3 items shipped')), '3 items shipped');
});

test('the name after a greeting at the start of a line becomes [name]', () => {
  assert.equal(body(redact('Hi Alex,\nHello Jamie Lee,\nDear Sam\nYour order')), 'Hi [name], Hello [name], Dear [name] Your order');
});

test('amounts, dates and merchant names survive', () => {
  const text = 'Total: $1,234.56 charged on 2026-11-28 by Acme Store. Due Dec 5, 2026. Paid 12 Nov 2026 and Nov 28 2026.';
  assert.equal(body(redact(text)), text);
});

test('whitespace is collapsed and the body is cut to 4000 characters', () => {
  assert.equal(body(redact('a  b\n\n\tc')), 'a b c');
  assert.equal(body(redact('word '.repeat(2000))).length, 4000);
});

test('card numbers split by nbsp, double spaces, dots or slashes become [number]', () => {
  assert.equal(body(redact('Card: 6035 3201 2345 6789')), 'Card: [number]');
  assert.equal(body(redact('4111  1111  1111  1111')), '[number]');
  assert.equal(body(redact('4111.1111.1111.1111')), '[number]');
  assert.equal(body(redact('4111/1111/1111/1111')), '[number]');
  assert.equal(body(redact('Card 4111\n1111\n1111\n1111')), 'Card [number]');
});

test('d/m/y dates and prices next to small numbers survive the wider number rule', () => {
  assert.equal(body(redact('Shipped 11/28/2026 and 3/4/26.')), 'Shipped 11/28/2026 and 3/4/26.');
  assert.equal(body(redact('Qty 10 19.99 each')), 'Qty 10 19.99 each');
});

test('labelled PINs, security codes and claim codes become [code]', () => {
  assert.equal(body(redact('PIN: 4821')), 'PIN [code]');
  assert.equal(body(redact('Security code 731')), 'Security code [code]');
  assert.equal(body(redact('Access number 55210')), 'Access number [code]');
  assert.equal(body(redact('Claim code: AQ7X-KRBNZK-49PL')), 'Claim code [code]');
  assert.equal(body(redact('Your passcode is 9921 today')), 'Your passcode [code] today');
  assert.equal(body(redact('Redemption code: ABCDEFGH')), 'Redemption code [code]');
  assert.equal(body(redact('CVV 123')), 'CVV [code]');
  assert.equal(body(redact('A PIN is required')), 'A PIN is required');
});

test('a token of 8+ letters and digits becomes [code], plain words and small numbers stay', () => {
  assert.equal(body(redact('Gift AQ7X-KRBNZK-49PL here')), 'Gift [code] here');
  assert.equal(body(redact('Use XK29PLM8Q1 at checkout')), 'Use [code] at checkout');
  assert.equal(body(redact('Order A1B2 from Acme and 12345')), 'Order A1B2 from Acme and 12345');
});

test('street addresses are found anywhere, with numbered streets and more suffixes', () => {
  assert.equal(body(redact('Ship to: Jane Doe, 123 Main St, Springfield, IL 62704')), 'Ship to: Jane Doe, [address], Springfield, [address]');
  for (const a of ['350 5th Ave', '123 W 42nd St', '12 Oak Pkwy', '9 Elm Cir', '5 Pine Ter', '8 Bay Trl', '77 Ridge Hwy', '4 Market Sq', '6 Park Loop']) {
    assert.equal(body(redact(a)), '[address]', a);
  }
  assert.equal(body(redact('Sent to 22 Baker Street today')), 'Sent to [address] today');
});

test('greetings: comma, titles and accented names', () => {
  assert.equal(body(redact('Hello, Jane')), 'Hello [name]');
  assert.equal(body(redact('Hi, Jane,')), 'Hi [name],');
  assert.equal(body(redact('Dear Mr. Smith,')), 'Dear [name],');
  assert.equal(body(redact('Hi Émilie')), 'Hi [name]');
  assert.equal(body(redact('Hi Zoë')), 'Hi [name]');
});

test('phones with dots or a country code, and links with no scheme', () => {
  assert.equal(body(redact('Tel.555.123.4567')), 'Tel.[phone]');
  assert.equal(body(redact('1.555.123.4567')), '[phone]');
  assert.equal(body(redact('Call +1 555 123 4567 now')), 'Call [phone] now');
  assert.equal(body(redact('See klarna.com/r/Ab12Cd34Ef now')), 'See [link klarna.com] now');
});

test('a mail that htmlToText returns as one line is still redacted', () => {
  const one = 'Hi Jane, Order shipped. Hello Jane, thanks. Ship to: Jane Doe, 350 5th Ave, New York, NY 10001. Call 555-123-4567. PIN: 4821';
  assert.equal(body(redact(one)), 'Hi [name], Order shipped. Hello [name], thanks. Ship to: Jane Doe, [address], New York, [address]. Call [phone]. PIN [code]');
});

test('the system prompt names the placeholders and the answer keys', () => {
  for (const s of ['[number]', 'ignore_rule', 'ingest_kind', 'recommend']) assert.ok(TRIAGE_SYSTEM.includes(s), s);
});

const good = {
  category: 'bill', recommend: 'ingest', reason: 'A lease bill', ignore_rule: null, ingest_kind: 'lease bill',
  fields: { 'amount due': '$40.00', pages: 5 },
};

test('parseTriageResult accepts a good answer', () => {
  assert.deepEqual(parseTriageResult(good), {
    category: 'bill', recommend: 'ingest', reason: 'A lease bill', ignoreRule: null, ingestKind: 'lease bill',
    fields: { 'amount due': '$40.00', pages: '5' },
  });
  assert.deepEqual(parseTriageResult({ category: 'marketing', recommend: 'ignore', reason: 'Promo', ignore_rule: { from_domain: 'Mail.Example.com', subject_contains: ' sale ' }, ingest_kind: null, fields: {} }), {
    category: 'marketing', recommend: 'ignore', reason: 'Promo', ignoreRule: { fromDomain: 'mail.example.com', subjectContains: 'sale' }, ingestKind: null, fields: {},
  });
});

test('parseTriageResult drops unknown keys and cuts long strings', () => {
  const many = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, 'v']));
  const r = parseTriageResult({ ...good, extra: 'x', reason: 'x'.repeat(300), fields: { ['k'.repeat(60)]: 'v'.repeat(300), ...many } });
  assert.ok(r);
  assert.deepEqual(Object.keys(r).sort(), ['category', 'fields', 'ignoreRule', 'ingestKind', 'reason', 'recommend']);
  assert.equal(r.reason.length, 200);
  assert.equal(Object.keys(r.fields).length, 12);
  assert.equal(r.fields['k'.repeat(40)].length, 120);
});

test('parseTriageResult rejects wrong types', () => {
  assert.equal(parseTriageResult({ ...good, category: 'spam' }), null);
  assert.equal(parseTriageResult({ ...good, recommend: 5 }), null);
  assert.equal(parseTriageResult({ ...good, reason: undefined }), null);
  assert.equal(parseTriageResult({ ...good, fields: ['a'] }), null);
  assert.equal(parseTriageResult({ ...good, ignore_rule: 'klarna.com' }), null);
  assert.equal(parseTriageResult({ ...good, ignore_rule: { from_domain: 3 } }), null);
  assert.equal(parseTriageResult({ ...good, ingest_kind: 7 }), null);
});

test('parseTriageResult rejects anything that is not an object', () => {
  for (const v of [null, undefined, 'text', 5, true, [], [good]]) assert.equal(parseTriageResult(v), null);
});

test('matchesIgnoreRule: exact and parent domain, optional subject, no look-alike domains', () => {
  const rules = [{ fromDomain: 'klarna.com', subjectContains: null }];
  assert.equal(matchesIgnoreRule(rules, 'klarna.com', 'Hi'), true);
  assert.equal(matchesIgnoreRule(rules, 'mail.klarna.com', 'Hi'), true);
  assert.equal(matchesIgnoreRule(rules, 'notklarna.com', 'Hi'), false);
  assert.equal(matchesIgnoreRule(rules, 'klarna.com.evil.example', 'Hi'), false);
  assert.equal(matchesIgnoreRule(rules, '', 'Hi'), false);
  const sub = [{ fromDomain: 'klarna.com', subjectContains: 'Weekly Deals' }];
  assert.equal(matchesIgnoreRule(sub, 'klarna.com', 'your weekly deals are here'), true);
  assert.equal(matchesIgnoreRule(sub, 'klarna.com', 'Your statement'), false);
  assert.equal(matchesIgnoreRule([], 'klarna.com', 'Hi'), false);
});

test('normalizeDomain strips "@", schemes, paths and ports, and rejects non-domains', () => {
  assert.equal(normalizeDomain('@klarna.com'), 'klarna.com');
  assert.equal(normalizeDomain('https://Klarna.com'), 'klarna.com');
  assert.equal(normalizeDomain('https://mail.klarna.com:443/x?y=1'), 'mail.klarna.com');
  assert.equal(normalizeDomain('no-reply@klarna.com.'), 'klarna.com');
  for (const bad of ['com', '', 'a b.com', 'not a domain', '.com', 'x.c']) assert.equal(normalizeDomain(bad), '', bad);
});

test('safeIgnoreRule: the model may only narrow the sender domain', () => {
  const row = (fromDomain: string, ruleFromDomain: string | null, ruleSubject: string | null = null) => ({ fromDomain, ruleFromDomain, ruleSubject });
  // Too broad or unrelated: the sender's own domain, no subject.
  assert.deepEqual(safeIgnoreRule(row('deals.shop.com', 'com', 'Sale')), { fromDomain: 'deals.shop.com', subjectContains: null });
  assert.deepEqual(safeIgnoreRule(row('mail.klarna.com', 'paypal.com', 'Sale')), { fromDomain: 'mail.klarna.com', subjectContains: null });
  assert.deepEqual(safeIgnoreRule(row('mail.example.co.uk', 'co.uk')), { fromDomain: 'mail.example.co.uk', subjectContains: null });
  assert.deepEqual(safeIgnoreRule(row('mail.gmail.com', 'gmail.com')), { fromDomain: 'mail.gmail.com', subjectContains: null });
  assert.deepEqual(safeIgnoreRule(row('shop.com', 'deals.shop.com')), { fromDomain: 'shop.com', subjectContains: null });
  assert.deepEqual(safeIgnoreRule(row('notshop.com', 'shop.com')), { fromDomain: 'notshop.com', subjectContains: null });
  assert.deepEqual(safeIgnoreRule(row('shop.com', null)), { fromDomain: 'shop.com', subjectContains: null });
  // The sender's domain or a parent of it is kept, with the subject.
  assert.deepEqual(safeIgnoreRule(row('deals.shop.com', 'shop.com', ' Sale ')), { fromDomain: 'shop.com', subjectContains: 'Sale' });
  assert.deepEqual(safeIgnoreRule(row('klarna.com', '@klarna.com')), { fromDomain: 'klarna.com', subjectContains: null });
  assert.deepEqual(safeIgnoreRule(row('klarna.com', 'https://klarna.com', 'Deals')), { fromDomain: 'klarna.com', subjectContains: 'Deals' });
  // Nothing safe to ignore.
  for (const own of ['', 'gmail.com', 'co.uk', 'com', 'proton.me']) assert.equal(safeIgnoreRule(row(own, own || null)), null, own);
});

test('submitErrorKind: only 413 and 422 are about one message; null and odd values do not throw', () => {
  assert.deepEqual(submitErrorKind({ status: 413 }), { kind: 'rejected', status: 413 });
  assert.deepEqual(submitErrorKind({ status: 422 }), { kind: 'rejected', status: 422 });
  for (const s of [400, 401, 403, 429, 500, 503]) assert.deepEqual(submitErrorKind({ status: s }), { kind: 'stop', status: s });
  for (const e of [null, undefined, 'boom', new Error('x'), { status: '413' }, 5]) assert.deepEqual(submitErrorKind(e), { kind: 'stop', status: null });
});

test('senderDomain of a bare address is its domain, never a display name', () => {
  assert.equal(senderDomain('alerts@evil.example'), 'evil.example');
});

test('triageRef fits the queue ref rule and is stable', () => {
  const ref = triageRef('msg-1');
  assert.match(ref, /^[A-Za-z0-9._:-]{1,64}$/);
  assert.equal(ref, triageRef('msg-1'));
  assert.notEqual(ref, triageRef('msg-2'));
  assert.match(triageRef('x'.repeat(500) + ' <odd/id>'), /^[A-Za-z0-9._:-]{1,64}$/);
});

test('triageDigestLine: nothing at zero, counts without the empty parts', () => {
  assert.equal(triageDigestLine({ found: 0, ignore: 0, ingest: 0, review: 0 }), null);
  assert.equal(triageDigestLine({ found: 3, ignore: 2, ingest: 1, review: 0 }), 'Inbox triage: 3 unrecognized emails (1 to ingest, 2 to ignore).');
  assert.equal(triageDigestLine({ found: 1, ignore: 0, ingest: 0, review: 1 }), 'Inbox triage: 1 unrecognized email (1 to review).');
  assert.equal(triageDigestLine({ found: 1, ignore: 0, ingest: 0, review: 0 }), 'Inbox triage: 1 unrecognized email.');
});

test('triageDigestLine passes the queue privacy check and fits', () => {
  for (const c of [{ found: 3, ignore: 2, ingest: 1, review: 0 }, { found: 99999, ignore: 33333, ingest: 33333, review: 33333 }]) {
    const line = triageDigestLine(c)!;
    assert.equal(lineLooksPrivate(line), false, line);
    assert.ok(Array.from(line).length <= MAX_LINE_CHARS);
  }
});
