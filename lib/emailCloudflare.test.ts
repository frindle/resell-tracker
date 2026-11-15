import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchCloudflareOrderEmails, deleteCloudflareMessages, testCloudflare } from './emailCloudflare.ts';

const creds = { url: 'https://inbox.example.test/', token: 'tok-123' };
const ORDER = '111-2223334-4445556';

function mime(subject: string, body: string, date: string, from = 'Amazon.com <auto-confirm@amazon.com>'): string {
  return [
    `From: ${from}`,
    'To: sam.alias@relay.test',
    `Subject: ${subject}`,
    `Date: ${date}`,
    'Message-ID: <abc123@mail.example.test>',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    body,
  ].join('\r\n');
}

const orderBody = [
  'Hello Sam,',
  `Order # ${ORDER}`,
  'Ship to',
  'SAM EXAMPLE',
  '100 TEST ST',
  'SPRINGFIELD, ZZ 00001',
  '',
  'Order Total: $203.29',
].join('\r\n');

const NOTES = mime('Weekly newsletter', 'Nothing to see here.', 'Sat, 14 Nov 2026 09:00:00 +0000', 'News <news@club.example.test>');

type Call = { url: string; method: string; auth: string | null };

function fakeFetch(messages: Record<string, { to: string; receivedAt: string; raw: string }>, calls: Call[], pageSize = 100) {
  const ids = Object.keys(messages).sort();
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input));
    const method = init?.method ?? 'GET';
    const auth = new Headers(init?.headers).get('authorization');
    calls.push({ url: u.pathname + u.search, method, auth });
    if (auth !== 'Bearer tok-123') return new Response('no', { status: 401 });
    if (u.pathname === '/messages') {
      const limit = Math.min(Number(u.searchParams.get('limit')) || 100, pageSize);
      const start = Number(u.searchParams.get('cursor') || 0);
      const slice = ids.slice(start, start + limit);
      const end = start + slice.length;
      return Response.json({
        messages: slice.map(id => ({ id, to: messages[id].to, from: 'x@y.test', size: messages[id].raw.length, receivedAt: messages[id].receivedAt })),
        cursor: end >= ids.length ? null : String(end),
        complete: end >= ids.length,
      });
    }
    const id = decodeURIComponent(u.pathname.slice('/messages/'.length));
    if (method === 'DELETE') return new Response(null, { status: 204 });
    if (!messages[id]) return new Response('nf', { status: 404 });
    return new Response(messages[id].raw, { headers: { 'content-type': 'message/rfc822' } });
  }) as typeof fetch;
}

test('cloudflare source parses order mail, adds envelope to, skips non-orders, newest first', async () => {
  const calls: Call[] = [];
  const f = fakeFetch({
    'm:2026-11-13T10:00:00.000Z:a': { to: 'sam@orders.example.test', receivedAt: '2026-11-13T10:00:00.000Z', raw: mime('Ordered: "Widget Pro"', orderBody, 'Fri, 13 Nov 2026 10:00:00 +0000') },
    'm:2026-11-14T09:00:00.000Z:b': { to: 'sam@orders.example.test', receivedAt: '2026-11-14T09:00:00.000Z', raw: NOTES },
    'm:2026-11-14T11:00:00.000Z:c': { to: 'kim@orders.example.test', receivedAt: '2026-11-14T11:00:00.000Z', raw: mime('Ordered: "Gadget"', orderBody, 'Sat, 14 Nov 2026 11:00:00 +0000') },
  }, calls);
  const rows = await fetchCloudflareOrderEmails(creds, undefined, { fetchFn: f });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].uid, 'm:2026-11-14T11:00:00.000Z:c');
  assert.equal(rows[1].uid, 'm:2026-11-13T10:00:00.000Z:a');
  assert.equal(rows[1].orderNumber, ORDER);
  assert.equal(rows[1].platform, 'Amazon');
  assert.equal(rows[1].cost, 203.29);
  assert.equal(rows[1].recipients[0], 'sam@orders.example.test');
  assert.ok(rows[1].recipients.includes('sam.alias@relay.test'));
  assert.equal(rows[0].recipients[0], 'kim@orders.example.test');
  assert.ok(calls.every(c => c.auth === 'Bearer tok-123'));
  assert.ok(calls.some(c => c.url === '/messages/' + encodeURIComponent('m:2026-11-13T10:00:00.000Z:a')));
});

test('cloudflare source follows cursors and honours since', async () => {
  const calls: Call[] = [];
  const msgs: Record<string, { to: string; receivedAt: string; raw: string }> = {};
  for (let d = 10; d <= 14; d++) {
    const at = `2026-11-${d}T10:00:00.000Z`;
    msgs[`m:${at}:x`] = { to: 'sam@orders.example.test', receivedAt: at, raw: mime('Ordered: "Widget"', orderBody, `${d} Nov 2026 10:00:00 +0000`) };
  }
  const f = fakeFetch(msgs, calls, 2);
  const rows = await fetchCloudflareOrderEmails(creds, new Date('2026-11-12T00:00:00Z'), { fetchFn: f });
  assert.equal(rows.length, 3);
  assert.equal(calls.filter(c => c.url.startsWith('/messages?')).length, 3);
  // Only messages inside the window were downloaded.
  assert.equal(calls.filter(c => c.url.startsWith('/messages/')).length, 3);
});

test('cloudflare delete issues DELETE per id, tolerates 404, throws on failure', async () => {
  const calls: Call[] = [];
  await deleteCloudflareMessages(creds, ['m:a', 'm:b'], fakeFetch({}, calls));
  assert.deepEqual(calls.map(c => [c.method, c.url]), [['DELETE', '/messages/m%3Aa'], ['DELETE', '/messages/m%3Ab']]);
  const bad = (async () => new Response('x', { status: 500 })) as unknown as typeof fetch;
  await assert.rejects(deleteCloudflareMessages(creds, ['m:a'], bad), /HTTP 500/);
  const gone = (async () => new Response('x', { status: 404 })) as unknown as typeof fetch;
  await deleteCloudflareMessages(creds, ['m:a'], gone);
});

test('test connection lists with limit=1 and fails on bad token', async () => {
  const calls: Call[] = [];
  await testCloudflare(creds, fakeFetch({}, calls));
  assert.equal(calls[0].url, '/messages?limit=1');
  await assert.rejects(testCloudflare({ ...creds, token: 'wrong' }, fakeFetch({}, [])), /HTTP 401/);
});
