import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bloomAccess, verifyAccessJwt, viaDomain, isBloomPath, resetKeyCache } from './bloomAccess.ts';

// A throwaway RSA key stands in for the team's key; the "certs" fetch is faked. Nothing leaves this process.
const TEAM = 'team.example.test';
const ENV = { CF_ACCESS_TEAM_DOMAIN: TEAM, CF_ACCESS_AUDS: 'aud-1,aud-2' };
const b64u = (b: ArrayBuffer | string) => Buffer.from(typeof b === 'string' ? b : new Uint8Array(b)).toString('base64url');

async function setup() {
  resetKeyCache();
  const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  let fetches = 0;
  const f = (async (url: string) => {
    fetches++;
    assert.equal(url, `https://${TEAM}/cdn-cgi/access/certs`);
    return new Response(JSON.stringify({ keys: [{ ...jwk, kid: 'k1' }] }));
  }) as unknown as typeof fetch;
  const sign = async (claims: Record<string, unknown>, header: Record<string, unknown> = { alg: 'RS256', kid: 'k1' }) => {
    const head = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(claims))}`;
    const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(head));
    return `${head}.${b64u(sig)}`;
  };
  return { f, sign, fetches: () => fetches };
}
const good = { iss: `https://${TEAM}`, aud: ['aud-2'], exp: Math.floor(Date.now() / 1000) + 600 };

test('a request with no Cloudflare header is the LAN: open, no token needed', async () => {
  assert.equal(viaDomain(new Headers({ host: '192.0.2.10:3000' })), false);
  assert.deepEqual(await bloomAccess(new Headers({ host: '192.0.2.10:3000' }), {}), { ok: true, via: 'lan' });
});

test('any Cloudflare header means the domain, and then a valid Access JWT is required', async () => {
  for (const h of ['cf-ray', 'cf-connecting-ip', 'cf-visitor', 'cf-access-jwt-assertion']) {
    assert.equal(viaDomain(new Headers({ [h]: 'x' })), true, h);
    const r = await bloomAccess(new Headers({ [h]: 'x' }), ENV);
    assert.equal(r.ok, false, h);
  }
});

test('valid JWT passes; wrong audience, issuer, expiry, alg, signature and unknown key are refused', async () => {
  const { f, sign } = await setup();
  const v = (t: string) => verifyAccessJwt(t, ENV, f);
  assert.deepEqual(await v(await sign(good)), { ok: true });
  assert.deepEqual(await v(await sign({ ...good, aud: 'aud-1' })), { ok: true });
  assert.deepEqual(await v(await sign({ ...good, aud: ['other'] })), { ok: false, reason: 'jwt audience' });
  assert.deepEqual(await v(await sign({ ...good, iss: 'https://evil.test' })), { ok: false, reason: 'jwt issuer' });
  assert.deepEqual(await v(await sign({ ...good, exp: Math.floor(Date.now() / 1000) - 3600 })), { ok: false, reason: 'jwt expired' });
  assert.deepEqual(await v(await sign({ ...good, exp: undefined })), { ok: false, reason: 'jwt exp missing' });
  assert.deepEqual(await v(await sign(good, { alg: 'none', kid: 'k1' })), { ok: false, reason: 'jwt alg' });
  assert.deepEqual(await v(await sign(good, { alg: 'RS256', kid: 'nope' })), { ok: false, reason: 'jwt unknown key' });
  const t = await sign(good);
  const forged = t.split('.').slice(0, 2).concat(b64u('not the signature')).join('.');
  assert.deepEqual(await v(forged), { ok: false, reason: 'jwt bad signature' });
  assert.deepEqual(await v('a.b'), { ok: false, reason: 'jwt malformed' });
});

test('not configured fails closed, and keys are fetched once and cached', async () => {
  const { f, sign, fetches } = await setup();
  assert.deepEqual(await verifyAccessJwt(await sign(good), {}, f), { ok: false, reason: 'access not configured' });
  assert.deepEqual(await verifyAccessJwt(await sign(good), { CF_ACCESS_TEAM_DOMAIN: TEAM }, f), { ok: false, reason: 'access not configured' });
  await verifyAccessJwt(await sign(good), ENV, f);
  await verifyAccessJwt(await sign(good), ENV, f);
  assert.equal(fetches(), 1);
});

test('only Bloom paths use this gate', () => {
  for (const p of ['/bloom', '/bloom/2030-01', '/api/bloom/invoices', '/api/bloom/invoices/sync']) assert.equal(isBloomPath(p), true, p);
  for (const p of ['/', '/bloomberg', '/api/bloomx', '/analytics', '/api/books/tally']) assert.equal(isBloomPath(p), false, p);
});
