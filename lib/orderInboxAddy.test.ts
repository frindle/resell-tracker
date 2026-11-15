import test from 'node:test';
import assert from 'node:assert/strict';
import { handleFetch, hmacHex } from '../workers/order-inbox/src/handlers.js';
import { fetchCloudflareOrderEmails } from './emailCloudflare.ts';
import { routeEmail } from './emailParse.ts';

// End to end: an addy.io webhook POST goes through the real worker into a fake
// KV, then the tracker pulls it through the same worker and parses it. Proves
// the rebuilt message carries everything the importer needs.

const ORDER = '111-2223334-4445556';
const SECRET = 'whsec-e2e';

function fakeKV() {
  const store = new Map<string, { value: Uint8Array; opts: { metadata?: unknown } }>();
  return {
    store,
    async put(key: string, value: Uint8Array, opts: { metadata?: unknown }) { store.set(key, { value, opts }); },
    async get(key: string) {
      const e = store.get(key);
      return e ? e.value.buffer.slice(e.value.byteOffset, e.value.byteOffset + e.value.byteLength) : null;
    },
    async delete(key: string) { store.delete(key); },
    async list({ prefix, limit }: { prefix: string; limit: number }) {
      const names = [...store.keys()].filter(k => k.startsWith(prefix)).sort().slice(0, limit);
      return { keys: names.map(name => ({ name, metadata: store.get(name)!.opts.metadata })), list_complete: true };
    },
  };
}

const env = () => ({
  ORDER_MAIL: fakeKV(),
  PULL_TOKEN: 'tok-e2e',
  ADDY_WEBHOOK_SECRET: SECRET,
  ADDY_RECIPIENTS: 'sam@orders.example.test,kim@orders.example.test',
});

const orderText = [
  'Hello Sam,',
  `Order # ${ORDER}`,
  'Ship to',
  'SAM EXAMPLE',
  '100 TEST ST',
  'SPRINGFIELD, ZZ 00001',
  '',
  'Order Total: $203.29',
].join('\n');

function payload(over: Record<string, unknown> = {}) {
  return {
    id: 'b'.repeat(64),
    event: 'alias.email.received',
    email_type: 'forward',
    alias: { id: 'alias-1', email: 'amzn.k3@alias.example.test' },
    from: 'auto-confirm@amazon.com',
    subject: 'Ordered: "Widget Pro – Größe M"',
    message_id: 'order-1@amazon.example.test',
    size: 2048,
    attachment_count: 0,
    received_at: '2026-11-15T21:05:00+00:00',
    headers: [
      { name: 'from', value: 'Amazon.com Kundenservice Ü <auto-confirm@amazon.com>' },
      { name: 'to', value: 'amzn.k3@alias.example.test' },
      { name: 'subject', value: 'Ordered: "Widget Pro – Größe M"' },
      { name: 'date', value: 'Sun, 15 Nov 2026 13:05:00 -0800' },
      { name: 'message-id', value: '<order-1@amazon.example.test>' },
      { name: 'content-type', value: 'multipart/alternative; boundary="x"' },
    ],
    text: orderText,
    html: `<p>Hello Sam,</p><p>Order # ${ORDER}</p><p>Order Total: $203.29</p>`,
    truncated: false,
    ...over,
  };
}

async function post(e: ReturnType<typeof env>, path: string, p: object) {
  const body = JSON.stringify(p);
  const req = new Request('https://inbox.example.test' + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-addy-signature': await hmacHex(SECRET, body) },
    body,
  });
  return handleFetch(req, e);
}

const viaWorker = (e: ReturnType<typeof env>) =>
  (async (input: RequestInfo | URL, init?: RequestInit) => handleFetch(new Request(String(input), init), e)) as typeof fetch;

test('addy webhook -> worker -> tracker import parses and routes the order', async () => {
  const e = env();
  assert.equal((await post(e, '/addy/sam', payload())).status, 204);
  assert.equal((await post(e, '/addy/kim', payload({ id: 'c'.repeat(64), received_at: '2026-11-15T21:06:00+00:00', html: '' }))).status, 204);

  const rows = await fetchCloudflareOrderEmails({ url: 'https://inbox.example.test', token: 'tok-e2e' }, undefined, { fetchFn: viaWorker(e) });
  assert.equal(rows.length, 2);
  const sam = rows.find(r => r.recipients.includes('sam@orders.example.test'))!;
  const kim = rows.find(r => r.recipients.includes('kim@orders.example.test'))!;
  assert.ok(sam && kim && sam !== kim);
  assert.ok(!sam.recipients.includes('kim@orders.example.test'));
  for (const r of [sam, kim]) {
    assert.equal(r.platform, 'Amazon');
    assert.equal(r.kind, 'ordered');
    assert.equal(r.orderNumber, ORDER);
    assert.equal(r.cost, 203.29);
    assert.equal(r.subject, 'Ordered: "Widget Pro – Größe M"');
    assert.equal(r.messageId, '<order-1@amazon.example.test>');
    assert.equal(r.date, '2026-11-15T21:05:00.000Z');
    assert.ok(r.recipients.includes('amzn.k3@alias.example.test'));
  }
  assert.match(sam.from, /auto-confirm@amazon\.com/);

  const rules = [{ userId: 1, pattern: 'sam@orders.example.test' }, { userId: 2, pattern: 'kim@orders.example.test' }];
  assert.deepEqual(routeEmail(rules, { recipients: sam.recipients, senders: sam.senders }), { userId: 1, via: 'recipient' });
  assert.deepEqual(routeEmail(rules, { recipients: kim.recipients, senders: kim.senders }), { userId: 2, via: 'recipient' });
});

test('addy webhook html-only body still parses', async () => {
  const e = env();
  const html = `<html><body><p>Hello Sam,</p><p>Order # ${ORDER}</p><p>Order Total: $203.29</p></body></html>`;
  assert.equal((await post(e, '/addy/sam', payload({ text: '', html }))).status, 204);
  const rows = await fetchCloudflareOrderEmails({ url: 'https://inbox.example.test', token: 'tok-e2e' }, undefined, { fetchFn: viaWorker(e) });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].orderNumber, ORDER);
  assert.equal(rows[0].cost, 203.29);
});

test('addy webhook without headers falls back to payload from/subject', async () => {
  const e = env();
  assert.equal((await post(e, '/addy/sam', payload({ headers: undefined }))).status, 204);
  const rows = await fetchCloudflareOrderEmails({ url: 'https://inbox.example.test', token: 'tok-e2e' }, undefined, { fetchFn: viaWorker(e) });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].platform, 'Amazon');
  assert.equal(rows[0].orderNumber, ORDER);
  assert.ok(rows[0].recipients.includes('sam@orders.example.test'));
});
