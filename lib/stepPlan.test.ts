import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createPublicKey, verify } from 'node:crypto';
import { validatePlanFile, loadPlans, plansEtag, plansResponse } from './stepPlan.ts';

const url = (f: string) => new URL(`../config/${f}`, import.meta.url);
const text = readFileSync(url('plans.json'), 'utf8');

function withSecret<T>(value: string | undefined, fn: () => T): T {
  const prev = process.env.EXTENSION_SHARED_SECRET;
  if (value === undefined) delete process.env.EXTENSION_SHARED_SECRET; else process.env.EXTENSION_SHARED_SECRET = value;
  try { return fn(); } finally { if (prev === undefined) delete process.env.EXTENSION_SHARED_SECRET; else process.env.EXTENSION_SHARED_SECRET = prev; }
}
const req = (headers: Record<string, string> = {}) => new Request('http://x/api/extension/plans', { headers });

test('the checked-in plans validate', () => {
  const r = validatePlanFile(JSON.parse(text));
  assert.equal(r.ok, true, r.ok ? '' : r.reason);
});

test('validator rejects bad files', () => {
  const raw = JSON.parse(text);
  assert.equal(validatePlanFile({ ...raw, extra: 1 }).ok, false);
  assert.equal(validatePlanFile({ ...raw, version: 0 }).ok, false);
  assert.equal(validatePlanFile(null).ok, false);
  const name = Object.keys(raw.plans)[0];
  const evil = structuredClone(raw);
  evil.plans[name].hosts = ['evil.example.com'];
  assert.equal(validatePlanFile(evil).ok, false);
  const bogus = structuredClone(raw);
  bogus.plans[name].steps.push({ id: 'zz', do: 'eval', code: 'x' });
  assert.equal(validatePlanFile(bogus).ok, false);
});

test('serves the exact text, sig null when absent, and a sig when present', async () => {
  const a = loadPlans(text, null);
  assert.ok(a.ok);
  if (!a.ok) return;
  await withSecret(undefined, async () => {
    const res = plansResponse(req(), a);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('ETag'), a.etag);
    const body = await res.json();
    assert.equal(body.plans, text);
    assert.equal(body.sig, null);
  });
  const b = loadPlans(text, 'c2ln\n');
  assert.ok(b.ok);
  if (!b.ok) return;
  assert.equal(b.sig, 'c2ln');
  assert.notEqual(a.etag, b.etag);
  assert.equal(b.etag, plansEtag(b.file.version, text, 'c2ln'));
  assert.match(b.etag, /^"\d+-[0-9a-f]{16}"$/);
  await withSecret(undefined, async () => assert.equal((await plansResponse(req(), b).json()).sig, 'c2ln'));
});

test('304 on If-None-Match, 200 for a stale tag', () => {
  const l = loadPlans(text, null);
  assert.ok(l.ok);
  if (!l.ok) return;
  withSecret(undefined, () => {
    assert.equal(plansResponse(req({ 'If-None-Match': l.etag }), l).status, 304);
    assert.equal(plansResponse(req({ 'If-None-Match': '"1-0000000000000000"' }), l).status, 200);
  });
});

test('auth: 401 without the secret (even with a matching ETag); invalid file is 401 then 500', () => {
  const l = loadPlans(text, null);
  assert.ok(l.ok);
  if (!l.ok) return;
  withSecret('s3cret', () => {
    assert.equal(plansResponse(req(), l).status, 401);
    assert.equal(plansResponse(req({ 'X-Extension-Secret': 'nope', 'If-None-Match': l.etag }), l).status, 401);
    assert.equal(plansResponse(req({ 'X-Extension-Secret': 's3cret' }), l).status, 200);
    assert.equal(plansResponse(req({ 'X-Extension-Secret': 's3cret', 'If-None-Match': l.etag }), l).status, 304);
    const bad = loadPlans('{"nope":1}', null, () => {});
    assert.equal(plansResponse(req(), bad).status, 401);
    assert.equal(plansResponse(req({ 'X-Extension-Secret': 's3cret' }), bad).status, 500);
  });
});

test('an invalid or unparseable file logs one line and is answered with 500', () => {
  for (const t of ['{"version":1,"plans":{},"bogus":true}', 'not json']) {
    const lines: string[] = [];
    const l = loadPlans(t, null, m => lines.push(m));
    assert.equal(l.ok, false);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /\[plans\] INVALID/);
    assert.equal(withSecret(undefined, () => plansResponse(req(), l)).status, 500);
  }
});

const pubFile = url('plans.pub');
test('config/plans.json.sig verifies against config/plans.pub', { skip: existsSync(pubFile) ? false : 'config/plans.pub is absent: signing is not set up yet, signature check skipped' }, () => {
  assert.ok(existsSync(url('plans.json.sig')), 'config/plans.pub exists, so config/plans.json.sig must exist (the sign-plans workflow writes it on the PR)');
  const x = Buffer.from(readFileSync(pubFile, 'utf8').trim(), 'base64').toString('base64url');
  const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x }, format: 'jwk' });
  const sig = Buffer.from(readFileSync(url('plans.json.sig'), 'utf8').trim(), 'base64');
  assert.equal(verify(null, readFileSync(url('plans.json')), key, sig), true, 'signature does not match config/plans.json: re-run the sign-plans workflow');
});
