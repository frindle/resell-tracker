import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

// proxy.ts imports 'next/server', which plain node ESM cannot resolve.
// Stub it with a tiny fake via a resolve hook (no network/DB needed).
const STUB = `
export class NextResponse {
  constructor(body, init) { this.status = init?.status ?? 200; this.headers = new Map(); this.body = body; this.next_ = false; }
  static next() { const r = new NextResponse(null, { status: 200 }); r.next_ = true; return r; }
  static json(b, init) { return new NextResponse(JSON.stringify(b), init); }
  static redirect(u) { const r = new NextResponse(null, { status: 307 }); r.location = String(u); return r; }
}
export class NextRequest {}
`;
const HOOKS = `
export async function resolve(spec, ctx, next) {
  if (spec === 'next/server') return { url: 'data:text/javascript,' + encodeURIComponent(${JSON.stringify(STUB)}), shortCircuit: true };
  return next(spec, ctx);
}
`;
register('data:text/javascript,' + encodeURIComponent(HOOKS));

const proxy: any = await import('../proxy.ts');

test('isExtensionAllowedPath allows ingest + existing extension paths', () => {
  const fn = proxy.isExtensionAllowedPath;
  assert.equal(typeof fn, 'function', 'proxy.ts must export isExtensionAllowedPath');
  assert.equal(fn('/api/giftcard-ocr/ingest'), true);
  assert.equal(fn('/api/import'), true);
  assert.equal(fn('/api/extension/amazon-page'), true);
  assert.equal(fn('/api/extension/amazon-run'), true);
  assert.equal(fn('/api/extension/commands'), true);
  assert.equal(fn('/api/bfmr/sync'), true);
});

test('isExtensionAllowedPath rejects non-extension paths', () => {
  const fn = proxy.isExtensionAllowedPath;
  assert.equal(typeof fn, 'function', 'proxy.ts must export isExtensionAllowedPath');
  assert.equal(fn('/api/not-an-extension-path'), false);
  assert.equal(fn('/orders'), false);
});

function fakeReq(path: string, headers: Record<string, string>) {
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    method: 'POST',
    nextUrl: { pathname: path, clone: () => ({ pathname: path }) },
    headers: { get: (k: string) => h.get(k.toLowerCase()) ?? null, has: (k: string) => h.has(k.toLowerCase()) },
    cookies: { get: () => undefined },
  };
}

test('middleware: ingest path with right extension secret passes; wrong secret -> 401', () => {
  process.env.EXTENSION_SHARED_SECRET = 's3cret';
  try {
    const ok: any = proxy.default(fakeReq('/api/giftcard-ocr/ingest', { 'X-Extension-User-Id': '1', 'X-Extension-Secret': 's3cret' }));
    assert.equal(ok.status, 200);
    assert.equal(ok.next_, true, 'should fall through via NextResponse.next()');
    const bad: any = proxy.default(fakeReq('/api/giftcard-ocr/ingest', { 'X-Extension-User-Id': '1', 'X-Extension-Secret': 'nope' }));
    assert.equal(bad.status, 401);
  } finally {
    delete process.env.EXTENSION_SHARED_SECRET;
  }
});

test('middleware: Bloom is open on the LAN, needs Cloudflare Access through the domain, and skips the sign-in redirect', async () => {
  const lan: any = await proxy.default(fakeReq('/bloom', {}));
  assert.equal(lan.next_, true, 'LAN: no login');
  const lanApi: any = await proxy.default(fakeReq('/api/bloom/invoices', {}));
  assert.equal(lanApi.next_, true);
  const viaDomain: any = await proxy.default(fakeReq('/api/bloom/invoices', { 'Cf-Ray': 'abc' }));
  assert.equal(viaDomain.status, 403, 'through the domain without a valid Access token');
  const page: any = await proxy.default(fakeReq('/bloom', { 'Cf-Connecting-Ip': '203.0.113.9' }));
  assert.equal(page.status, 403);
  const other: any = proxy.default(fakeReq('/orders', {}));
  assert.equal(other.status, 307, 'the rest of the app still redirects to sign-in');
});

test('middleware: extension CORS preflight allows PATCH (command claim) and the extension headers', () => {
  const req: any = { ...fakeReq('/api/extension/commands/1', { Origin: 'chrome-extension://abc' }), method: 'OPTIONS' };
  const res: any = proxy.default(req);
  assert.equal(res.status, 204);
  const methods = String(res.headers.get('Access-Control-Allow-Methods')).split(/,\s*/);
  assert.ok(methods.includes('PATCH'), 'the extension PATCHes /api/extension/commands/[id] to claim a command');
  const allowed = String(res.headers.get('Access-Control-Allow-Headers')).toLowerCase();
  for (const h of ['content-type', 'x-api-key', 'x-extension-user-id', 'x-extension-secret', 'x-extension-browser']) {
    assert.ok(allowed.split(/,\s*/).includes(h), `preflight must allow ${h}`);
  }
});

test('middleware: pairing start and claim skip the secret check; approve and the rest still need it or a session', () => {
  process.env.EXTENSION_SHARED_SECRET = 's3cret';
  try {
    for (const p of ['/api/extension/pair', '/api/extension/pair/claim']) {
      const r: any = proxy.default(fakeReq(p, { Origin: 'chrome-extension://abc' }));
      assert.equal(r.next_, true, `${p} is open`);
      assert.equal(r.headers.get('Access-Control-Allow-Origin'), 'chrome-extension://abc');
    }
    const cmd: any = proxy.default(fakeReq('/api/extension/commands', { Origin: 'chrome-extension://abc' }));
    assert.equal(cmd.status, 401, 'other extension routes still need the secret');
    const approve: any = proxy.default(fakeReq('/api/extension/pair/approve', {}));
    assert.equal(approve.status, 401, 'approve needs the session cookie');
    const sub: any = proxy.default(fakeReq('/api/extension/pair/claim/x', { Origin: 'chrome-extension://abc' }));
    assert.equal(sub.status, 401, 'only the exact paths are open');
  } finally {
    delete process.env.EXTENSION_SHARED_SECRET;
  }
});

test('middleware: the sign-in redirect keeps the page to come back to', () => {
  const go = (path: string, search: string) => {
    const req: any = fakeReq(path, {});
    const target: any = { pathname: path };
    req.nextUrl.search = search;
    req.nextUrl.clone = () => target;
    const r: any = proxy.default(req);
    assert.equal(r.status, 307);
    return target;
  };
  assert.deepEqual(go('/extension/pair', '?code=abc'), { pathname: '/login', search: '?next=%2Fextension%2Fpair%3Fcode%3Dabc' });
  assert.deepEqual(go('/', ''), { pathname: '/login', search: '' });
});
