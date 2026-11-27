import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  validateScrapeConfig, loadScrapeConfig, scrapeConfigEtag, etagMatches, scrapeConfigResponse,
} from './scrapeConfig.ts';

const site = (over: Record<string, unknown> = {}) => ({
  selectors: { row: 'div.row' }, labels: { open: 'Open' }, patterns: { total: 'Total\\s+(\\d+)' },
  urls: { home: 'https://example.com/' }, timeoutsMs: { waitMs: 1000 }, ...over,
});
const good = (over: Record<string, unknown> = {}) => ({ version: 3, sites: { demo: site() }, ...over });

function withSecret<T>(value: string | undefined, fn: () => T): T {
  const prev = process.env.EXTENSION_SHARED_SECRET;
  if (value === undefined) delete process.env.EXTENSION_SHARED_SECRET; else process.env.EXTENSION_SHARED_SECRET = value;
  try { return fn(); } finally { if (prev === undefined) delete process.env.EXTENSION_SHARED_SECRET; else process.env.EXTENSION_SHARED_SECRET = prev; }
}
const req = (headers: Record<string, string> = {}) => new Request('http://x/api/extension/scrape-config', { headers });

test('the checked-in config validates', () => {
  const raw = JSON.parse(readFileSync(new URL('../config/scrape-config.json', import.meta.url), 'utf8'));
  const r = validateScrapeConfig(raw);
  assert.equal(r.ok, true, r.ok ? '' : r.error);
  for (const k of ['amazon', 'costco', 'walmart', 'costcoEgift', 'bestbuyEgift']) assert.ok(raw.sites[k], `site ${k}`);
});

test('a well-formed config validates and is copied', () => {
  const r = validateScrapeConfig(good());
  assert.equal(r.ok, true);
});

test('validator rejects functions and non-string values', () => {
  assert.equal(validateScrapeConfig(good({ sites: { demo: site({ selectors: { row: () => 'x' } }) } })).ok, false);
  assert.equal(validateScrapeConfig(good({ sites: { demo: site({ labels: { open: 5 } }) } })).ok, false);
  assert.equal(validateScrapeConfig(good({ sites: { demo: site({ urls: { home: null } }) } })).ok, false);
  assert.equal(validateScrapeConfig(good({ sites: { demo: site({ patterns: { total: /x/ }}) } })).ok, false);
  assert.equal(validateScrapeConfig(good({ sites: { demo: site({ timeoutsMs: { waitMs: '1000' } }) } })).ok, false);
  assert.equal(validateScrapeConfig(good({ sites: { demo: site({ timeoutsMs: { waitMs: 1.5 } }) } })).ok, false);
  assert.equal(validateScrapeConfig(good({ sites: { demo: site({ timeoutsMs: { waitMs: -1 } }) } })).ok, false);
});

test('validator rejects regex sources that do not compile', () => {
  const r = validateScrapeConfig(good({ sites: { demo: site({ patterns: { bad: '(unclosed' } }) } }));
  assert.equal(r.ok, false);
  assert.match(r.ok ? '' : r.error, /demo\.patterns\.bad/);
});

test('validator rejects unknown top-level and site keys, bad versions and missing groups', () => {
  assert.equal(validateScrapeConfig(good({ extra: 1 })).ok, false);
  assert.equal(validateScrapeConfig(good({ sites: { demo: site({ scripts: {} }) } })).ok, false);
  assert.equal(validateScrapeConfig(good({ version: 0 })).ok, false);
  assert.equal(validateScrapeConfig(good({ version: 1.5 })).ok, false);
  assert.equal(validateScrapeConfig(good({ version: '2' })).ok, false);
  assert.equal(validateScrapeConfig({ version: 1 }).ok, false);
  assert.equal(validateScrapeConfig(null).ok, false);
  assert.equal(validateScrapeConfig([]).ok, false);
  const { urls: _u, ...noUrls } = site();
  assert.equal(validateScrapeConfig(good({ sites: { demo: noUrls } })).ok, false);
});

test('an invalid config logs one clear line and is not served', () => {
  const lines: string[] = [];
  const loaded = loadScrapeConfig({ version: 1, sites: {}, bogus: true }, m => lines.push(m));
  assert.equal(loaded.ok, false);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /\[scrape-config\] INVALID/);
  assert.match(lines[0], /bogus/);
  const res = withSecret(undefined, () => scrapeConfigResponse(req(), loaded));
  assert.equal(res.status, 500);
});

test('ETag carries the version and changes with the content', () => {
  const a = loadScrapeConfig(good());
  const b = loadScrapeConfig(good({ sites: { demo: site({ selectors: { row: 'div.other' } }) } }));
  const c = loadScrapeConfig(good());
  assert.ok(a.ok && b.ok && c.ok);
  if (!a.ok || !b.ok || !c.ok) return;
  assert.match(a.etag, /^"3-[0-9a-f]{16}"$/);
  assert.notEqual(a.etag, b.etag);
  assert.equal(a.etag, c.etag);
  assert.equal(a.etag, scrapeConfigEtag(3, a.body));
});

test('etagMatches handles lists, weak tags and *', () => {
  assert.equal(etagMatches('"3-abc"', '"3-abc"'), true);
  assert.equal(etagMatches('W/"3-abc"', '"3-abc"'), true);
  assert.equal(etagMatches('"1-x", "3-abc"', '"3-abc"'), true);
  assert.equal(etagMatches('*', '"3-abc"'), true);
  assert.equal(etagMatches('"2-abc"', '"3-abc"'), false);
  assert.equal(etagMatches(null, '"3-abc"'), false);
});

test('200 with ETag, then 304 on If-None-Match, then 200 again for a stale tag', async () => {
  const loaded = loadScrapeConfig(good());
  assert.ok(loaded.ok);
  if (!loaded.ok) return;
  await withSecret(undefined, async () => {
    const first = scrapeConfigResponse(req(), loaded);
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('ETag'), loaded.etag);
    assert.match(first.headers.get('Content-Type') ?? '', /application\/json/);
    assert.deepEqual(await first.json(), loaded.config);
    const again = scrapeConfigResponse(req({ 'If-None-Match': loaded.etag }), loaded);
    assert.equal(again.status, 304);
    assert.equal(again.headers.get('ETag'), loaded.etag);
    assert.equal(await again.text(), '');
    const stale = scrapeConfigResponse(req({ 'If-None-Match': '"2-0000000000000000"' }), loaded);
    assert.equal(stale.status, 200);
  });
});

test('auth: with a shared secret configured, a missing or wrong secret is 401 (even with a matching ETag)', () => {
  const loaded = loadScrapeConfig(good());
  assert.ok(loaded.ok);
  if (!loaded.ok) return;
  withSecret('s3cret', () => {
    assert.equal(scrapeConfigResponse(req(), loaded).status, 401);
    assert.equal(scrapeConfigResponse(req({ 'X-Extension-Secret': 'nope' }), loaded).status, 401);
    assert.equal(scrapeConfigResponse(req({ 'X-Extension-Secret': 'nope', 'If-None-Match': loaded.etag }), loaded).status, 401);
    assert.equal(scrapeConfigResponse(req({ 'X-Extension-Secret': 's3cret' }), loaded).status, 200);
    assert.equal(scrapeConfigResponse(req({ 'X-Extension-Secret': 's3cret', 'If-None-Match': loaded.etag }), loaded).status, 304);
  });
});

test('auth: an invalid config still answers 401 before 500 to an unauthenticated caller', () => {
  const loaded = loadScrapeConfig({ nope: 1 }, () => {});
  withSecret('s3cret', () => {
    assert.equal(scrapeConfigResponse(req(), loaded).status, 401);
    assert.equal(scrapeConfigResponse(req({ 'X-Extension-Secret': 's3cret' }), loaded).status, 500);
  });
});
