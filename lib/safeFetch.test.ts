import test from 'node:test';
import assert from 'node:assert/strict';
import { assertPublicUrl, BlockedUrlError, fetchFinalUrl, isBlockedIp, type FetchLike, type Resolver } from './safeFetch.ts';

const pub: Resolver = async () => ['93.184.216.34'];

test('private, loopback, link-local, CGNAT, unique-local and unspecified literals are blocked', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '100.127.255.254', '0.0.0.0',
    '::', '::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '[::1]', 'not-an-ip']) {
    assert.equal(isBlockedIp(ip), true, ip);
  }
});

test('public addresses are allowed', () => {
  for (const ip of ['93.184.216.34', '8.8.8.8', '100.63.255.255', '100.128.0.1', '172.15.0.1', '172.32.0.1', '2606:2800:220:1::1']) assert.equal(isBlockedIp(ip), false, ip);
});

test('blocked IP literals and bad schemes are rejected before any fetch', async () => {
  let fetched = 0;
  const fetchImpl: FetchLike = async () => { fetched++; return { status: 200, headers: { get: () => null } }; };
  for (const u of ['http://127.0.0.1/', 'http://[::1]/', 'http://169.254.169.254/latest', 'http://100.64.0.5/', 'http://2130706433/', 'http://0x7f.1/', 'http://localhost/', 'ftp://example.com/', 'file:///etc/passwd']) {
    await assert.rejects(fetchFinalUrl(u, { resolve: pub, fetchImpl }), BlockedUrlError, u);
  }
  assert.equal(fetched, 0);
});

test('a hostname that resolves to a private address is rejected', async () => {
  await assert.rejects(assertPublicUrl('https://internal.example/', async () => ['10.0.0.8']), BlockedUrlError);
  await assert.rejects(assertPublicUrl('https://mixed.example/', async () => ['93.184.216.34', '192.168.0.2']), BlockedUrlError);
  await assert.rejects(assertPublicUrl('https://nx.example/', async () => { throw new Error('ENOTFOUND'); }), BlockedUrlError);
  await assertPublicUrl('https://ok.example/', pub);
});

const chain = (map: Record<string, string | number>, seen: string[] = []): FetchLike => async url => {
  seen.push(url);
  const next = map[url];
  return typeof next === 'string'
    ? { status: 302, headers: { get: n => (n === 'location' ? next : null) } }
    : { status: 200, headers: { get: () => null } };
};

test('follows redirects by hand and returns the last URL', async () => {
  const seen: string[] = [];
  const out = await fetchFinalUrl('https://a.example/x', { resolve: pub, fetchImpl: chain({ 'https://a.example/x': '/y', 'https://a.example/y': 'https://b.example/z' }, seen) });
  assert.equal(out, 'https://b.example/z');
  assert.deepEqual(seen, ['https://a.example/x', 'https://a.example/y', 'https://b.example/z']);
});

test('a redirect hop into a private address is blocked and never requested', async () => {
  const seen: string[] = [];
  const resolve: Resolver = async h => (h === 'evil.example' ? ['10.0.0.1'] : ['93.184.216.34']);
  await assert.rejects(
    fetchFinalUrl('https://a.example/x', { resolve, fetchImpl: chain({ 'https://a.example/x': 'https://evil.example/', 'https://evil.example/': 'x' }, seen) }),
    BlockedUrlError,
  );
  await assert.rejects(fetchFinalUrl('https://a.example/x', { resolve: pub, fetchImpl: chain({ 'https://a.example/x': 'http://169.254.169.254/' }, seen) }), BlockedUrlError);
  assert.deepEqual(seen, ['https://a.example/x', 'https://a.example/x']);
});

test('more than 5 redirects is an error', async () => {
  const map: Record<string, string> = {};
  for (let i = 0; i < 10; i++) map[`https://a.example/${i}`] = `https://a.example/${i + 1}`;
  const seen: string[] = [];
  await assert.rejects(fetchFinalUrl('https://a.example/0', { resolve: pub, fetchImpl: chain(map, seen) }), /too many redirects/);
  assert.equal(seen.length, 6);
  // exactly 5 redirects still resolves
  assert.equal(await fetchFinalUrl('https://a.example/5', { resolve: pub, fetchImpl: chain(map) }), 'https://a.example/10');
});
