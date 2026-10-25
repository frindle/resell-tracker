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
  assert.equal(fn('/api/extension/commands'), true);
  assert.equal(fn('/api/bfmr/sync'), true);
});

test('isExtensionAllowedPath rejects non-extension paths', () => {
  const fn = proxy.isExtensionAllowedPath;
  assert.equal(typeof fn, 'function', 'proxy.ts must export isExtensionAllowedPath');
  assert.equal(fn('/api/settings'), false);
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
