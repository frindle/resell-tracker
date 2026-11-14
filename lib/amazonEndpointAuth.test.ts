import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveExtensionUserId } from './extensionAuth.ts';
import { sidecarAmazonEnabled } from './amazonSidecar.ts';

const req = (h: Record<string, string>) => new Request('http://x/api/extension/amazon-page', { method: 'POST', headers: h });

test('amazon-page/amazon-run auth: no session and no secret is rejected (route returns 401)', () => {
  process.env.EXTENSION_SHARED_SECRET = 'sekrit';
  assert.equal(resolveExtensionUserId(req({}), null), null);
  assert.equal(resolveExtensionUserId(req({ 'X-Extension-User-Id': '1' }), null), null);
  assert.equal(resolveExtensionUserId(req({ 'X-Extension-User-Id': '1', 'X-Extension-Secret': 'wrong' }), null), null);
  assert.equal(resolveExtensionUserId(req({ 'X-Extension-User-Id': '1', 'X-Extension-Secret': 'sekrit' }), null), 1);
  delete process.env.EXTENSION_SHARED_SECRET;
});

test('sidecar Amazon is off unless SIDECAR_AMAZON_ENABLED=1', () => {
  assert.equal(sidecarAmazonEnabled({}), false);
  assert.equal(sidecarAmazonEnabled({ SIDECAR_AMAZON_ENABLED: '1' }), true);
});
