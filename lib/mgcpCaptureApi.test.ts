import test from 'node:test';
import assert from 'node:assert/strict';
import { handleList, handleCapture, handleStatus, type CaptureDeps, type CaptureLink } from './mgcpCaptureApi.ts';

function make(opts: { uid?: number | null; owner?: number } = {}) {
  const uid = opts.uid === undefined ? 7 : opts.uid;
  const owner = opts.owner ?? 7;
  const links: CaptureLink[] = [
    { id: 1, linkEnc: 'enc:AAA', status: 'pending' },
    { id: 2, linkEnc: 'enc:BBB', status: 'captured' },
  ];
  const commits: any[] = [];
  const deps: CaptureDeps = {
    authorize: () => uid,
    orderVisibleTo: async (_o, u) => u === owner,
    listOpenLinks: async () => links.filter((l) => l.status !== 'captured'),
    findLink: async (_o, id) => links.find((l) => l.id === id) ?? null,
    setLinkStatus: async (_o, id, st) => { links.find((l) => l.id === id)!.status = st; },
    saveFile: async (_o, f) => 'saved-' + f.name,
    commitCapture: async (a) => { commits.push(a); links.find((l) => l.id === a.linkId)!.status = 'captured'; return 99; },
    decrypt: (c) => c.slice(4),
  };
  return { deps, commits, links };
}
const form = (o: Record<string, string>, files: Record<string, string> = {}) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  for (const [k, v] of Object.entries(files)) f.set(k, new File([v], k + '.bin', { type: 'application/octet-stream' }));
  return new Request('http://x/api/extension/mgcp', { method: 'POST', body: f });
};
const base = { orderId: '42', linkId: '1', merchant: 'Total Wine', value: '100', cardNumber: '1234 5678 9012', pin: ' 4 4 4 4 ' };

test('unauthorised and foreign-order requests are rejected', async () => {
  assert.equal((await handleList(make({ uid: null }).deps, new Request('http://x/?orderId=42'))).status, 401);
  assert.equal((await handleList(make({ owner: 9 }).deps, new Request('http://x/?orderId=42'))).status, 404);
});

test('list returns only uncaptured links, decrypted, no-store', async () => {
  const res = await handleList(make().deps, new Request('http://x/?orderId=42'));
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await res.json(), { links: [{ id: 1, status: 'pending', link: 'AAA' }] });
});

test('capture strips whitespace, saves files, commits once, then 409s', async () => {
  const { deps, commits } = make();
  const res = await handleCapture(deps, form(base, { pdf: '%PDF-1.4 x', barcode: '%PDF-1.4 y' }));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, giftCardId: 99, files: 2 });
  assert.equal(commits[0].cardNumber, '123456789012');
  assert.equal(commits[0].pin, '4444');
  assert.equal(commits[0].files.length, 2);
  assert.equal((await handleCapture(deps, form(base))).status, 409);
});

test('capture validates fields and never echoes card data in errors', async () => {
  const { deps } = make();
  const res = await handleCapture(deps, form({ ...base, value: '0' }));
  assert.equal(res.status, 400);
  const t = await res.text();
  assert.ok(!t.includes('1234') && !t.includes('4444'));
  assert.equal((await handleCapture(deps, form({ ...base, linkId: '77' }))).status, 404);
});

test('status marks failed/pending but never un-captures', async () => {
  const { deps, links } = make();
  const req = (b: unknown) => new Request('http://x', { method: 'PATCH', body: JSON.stringify(b) });
  assert.equal((await handleStatus(deps, req({ orderId: 42, linkId: 1, status: 'failed' }))).status, 200);
  assert.equal(links[0].status, 'failed');
  assert.equal((await handleStatus(deps, req({ orderId: 42, linkId: 1, status: 'captured' }))).status, 400);
  assert.equal((await handleStatus(deps, req({ orderId: 42, linkId: 2, status: 'failed' }))).status, 409);
});

test('capture refuses a file whose bytes are not pdf/image, whatever the client says, and saves nothing', async () => {
  const { deps, commits } = make();
  const res = await handleCapture(deps, form(base, { pdf: '<html><script>alert(1)</script>' }));
  assert.equal(res.status, 400);
  assert.equal(commits.length, 0);
});
