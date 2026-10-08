import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { needsBrowserLikeTls, bfmrTlsConnectOptions, httpsFetch, type HttpsRequestFn } from './bfmrTlsFetch.ts';

test('needsBrowserLikeTls: only bfmr.com and www.bfmr.com', () => {
  assert.equal(needsBrowserLikeTls('https://www.bfmr.com/api/my-tracker'), true);
  assert.equal(needsBrowserLikeTls('https://bfmr.com/x'), true);
  assert.equal(needsBrowserLikeTls('https://WWW.BFMR.COM/x'), true);
  assert.equal(needsBrowserLikeTls('https://api.bfmr.com/x'), false);
  assert.equal(needsBrowserLikeTls('https://notbfmr.com/x'), false);
  assert.equal(needsBrowserLikeTls('https://api.bfmr.com.evil.com/x'), false);
  assert.equal(needsBrowserLikeTls('https://evil.com/www.bfmr.com'), false);
  assert.equal(needsBrowserLikeTls('not a url'), false);
});

test('bfmrTlsConnectOptions is the OpenSSL default cipher list', () => {
  assert.deepEqual(bfmrTlsConnectOptions(), { ciphers: 'DEFAULT' });
});

// Fake node:https.request: records the call, then on the next tick emits a
// response with data + end (or an error), like the real ClientRequest.
function fake(opts: {
  status?: number;
  headers?: Record<string, string | string[]>;
  chunks?: Array<string | Buffer>;
  error?: Error;
  hang?: boolean;
}) {
  const seen: { url?: URL; options?: any; written: string[]; ended: boolean; destroyed: boolean } = {
    written: [],
    ended: false,
    destroyed: false,
  };
  const requestFn: HttpsRequestFn = ((url: URL, options: any, cb: (r: any) => void) => {
    seen.url = url;
    seen.options = options;
    const req: any = new EventEmitter();
    req.write = (s: string) => seen.written.push(s);
    req.destroy = () => {
      seen.destroyed = true;
    };
    req.end = () => {
      seen.ended = true;
      if (opts.hang) return;
      setImmediate(() => {
        if (opts.error) return req.emit('error', opts.error);
        const res: any = new EventEmitter();
        res.statusCode = opts.status ?? 200;
        res.statusMessage = 'OK';
        res.headers = opts.headers ?? {};
        cb(res);
        for (const c of opts.chunks ?? []) res.emit('data', c);
        res.emit('end');
      });
    };
    return req;
  }) as unknown as HttpsRequestFn;
  return { requestFn, seen };
}

test('httpsFetch: forwards method/headers/body, passes ciphers, returns status+headers+body', async () => {
  const { requestFn, seen } = fake({
    status: 201,
    headers: { 'content-type': 'application/json', 'set-cookie': ['a=1', 'b=2'] },
    chunks: ['{"ok":', Buffer.from('true}')],
  });
  const res = await httpsFetch(
    'https://www.bfmr.com/api/my-tracker?x=1',
    { method: 'post', headers: { Authorization: 'Bearer T', 'Content-Type': 'application/json' }, body: '{"a":1}' },
    requestFn,
  );
  assert.equal(res.status, 201);
  assert.equal(res.headers.get('content-type'), 'application/json');
  assert.deepEqual(res.headers.getSetCookie(), ['a=1', 'b=2']);
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(seen.url?.href, 'https://www.bfmr.com/api/my-tracker?x=1');
  assert.equal(seen.options.method, 'POST');
  assert.equal(seen.options.ciphers, 'DEFAULT');
  assert.equal(seen.options.headers.authorization, 'Bearer T');
  assert.equal(seen.options.headers['content-length'], '7');
  assert.deepEqual(seen.written, ['{"a":1}']);
  assert.equal(seen.ended, true);
});

test('httpsFetch: 403 html from the WAF is surfaced as a normal Response', async () => {
  const { requestFn } = fake({ status: 403, headers: { server: 'awselb/2.0', 'content-type': 'text/html' }, chunks: ['<html>no</html>'] });
  const res = await httpsFetch('https://www.bfmr.com/api/x', {}, requestFn);
  assert.equal(res.status, 403);
  assert.equal(res.headers.get('server'), 'awselb/2.0');
  assert.equal(await res.text(), '<html>no</html>');
});

test('httpsFetch: GET without body writes nothing; 204 has null body', async () => {
  const { requestFn, seen } = fake({ status: 204 });
  const res = await httpsFetch('https://bfmr.com/api/x', {}, requestFn);
  assert.equal(res.status, 204);
  assert.equal(await res.text(), '');
  assert.equal(seen.options.method, 'GET');
  assert.deepEqual(seen.written, []);
});

test('httpsFetch: request error rejects', async () => {
  const { requestFn } = fake({ error: new Error('ECONNRESET') });
  await assert.rejects(httpsFetch('https://www.bfmr.com/api/x', {}, requestFn), /ECONNRESET/);
});

test('httpsFetch: honours AbortSignal (bfmrWeb relies on it for timeouts)', async () => {
  const { requestFn, seen } = fake({ hang: true });
  const ctrl = new AbortController();
  const p = httpsFetch('https://www.bfmr.com/api/x', { signal: ctrl.signal }, requestFn);
  ctrl.abort();
  await assert.rejects(p);
  assert.equal(seen.destroyed, true);
  const already = new AbortController();
  already.abort();
  await assert.rejects(httpsFetch('https://www.bfmr.com/api/x', { signal: already.signal }, fake({}).requestFn));
});
