/**
 * Regression tests for the extension-command endpoints' secret check.
 *
 * The bug: app/api/extension/commands/route.ts (GET) and
 * app/api/extension/commands/[id]/route.ts (PATCH) read X-Extension-Secret
 * only for logging/targeting, never validated it -- so once past proxy.ts's
 * own gate (see the comment on GET in route.ts for exactly how a real
 * browser extension can sail past that), nothing on these two endpoints
 * required the shared secret at all, even when EXTENSION_SHARED_SECRET was
 * configured. Both routes now call verifyExtensionSecret() and reject with
 * 401 on a mismatch.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { verifyExtensionSecret, resolveExtensionUserId } from './extensionAuth.ts';

function fakeRequest(headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/extension/commands', { headers });
}

test('no EXTENSION_SHARED_SECRET configured: any request is trusted (LAN-trust default)', () => {
  const prev = process.env.EXTENSION_SHARED_SECRET;
  delete process.env.EXTENSION_SHARED_SECRET;
  try {
    assert.equal(verifyExtensionSecret(fakeRequest()), true, 'no secret header, none required, must pass');
    assert.equal(verifyExtensionSecret(fakeRequest({ 'X-Extension-Secret': 'anything' })), true);
  } finally {
    if (prev !== undefined) process.env.EXTENSION_SHARED_SECRET = prev; else delete process.env.EXTENSION_SHARED_SECRET;
  }
});

test('EXTENSION_SHARED_SECRET configured: a missing header fails', () => {
  const prev = process.env.EXTENSION_SHARED_SECRET;
  process.env.EXTENSION_SHARED_SECRET = 'correct-secret';
  try {
    assert.equal(verifyExtensionSecret(fakeRequest()), false);
  } finally {
    if (prev !== undefined) process.env.EXTENSION_SHARED_SECRET = prev; else delete process.env.EXTENSION_SHARED_SECRET;
  }
});

test('EXTENSION_SHARED_SECRET configured: a wrong header fails', () => {
  const prev = process.env.EXTENSION_SHARED_SECRET;
  process.env.EXTENSION_SHARED_SECRET = 'correct-secret';
  try {
    assert.equal(verifyExtensionSecret(fakeRequest({ 'X-Extension-Secret': 'wrong' })), false);
  } finally {
    if (prev !== undefined) process.env.EXTENSION_SHARED_SECRET = prev; else delete process.env.EXTENSION_SHARED_SECRET;
  }
});

test('EXTENSION_SHARED_SECRET configured: the matching header passes', () => {
  const prev = process.env.EXTENSION_SHARED_SECRET;
  process.env.EXTENSION_SHARED_SECRET = 'correct-secret';
  try {
    assert.equal(verifyExtensionSecret(fakeRequest({ 'X-Extension-Secret': 'correct-secret' })), true);
  } finally {
    if (prev !== undefined) process.env.EXTENSION_SHARED_SECRET = prev; else delete process.env.EXTENSION_SHARED_SECRET;
  }
});

// resolveExtensionUserId: a header-claimed userId is only honored when the
// secret check passes (or no secret is configured) -- otherwise anyone on
// the LAN could impersonate an arbitrary userId just by setting the header.
test('resolveExtensionUserId: a session cookie userId always wins, no secret needed', () => {
  assert.equal(resolveExtensionUserId(fakeRequest({ 'X-Extension-User-Id': '99' }), 5), 5);
});

test('resolveExtensionUserId: header claim honored when no secret is configured', () => {
  const prev = process.env.EXTENSION_SHARED_SECRET;
  delete process.env.EXTENSION_SHARED_SECRET;
  try {
    assert.equal(resolveExtensionUserId(fakeRequest({ 'X-Extension-User-Id': '7' }), null), 7);
  } finally {
    if (prev !== undefined) process.env.EXTENSION_SHARED_SECRET = prev; else delete process.env.EXTENSION_SHARED_SECRET;
  }
});

test('resolveExtensionUserId: header claim rejected once a secret is configured and missing/wrong', () => {
  const prev = process.env.EXTENSION_SHARED_SECRET;
  process.env.EXTENSION_SHARED_SECRET = 'correct-secret';
  try {
    assert.equal(resolveExtensionUserId(fakeRequest({ 'X-Extension-User-Id': '7' }), null), null, 'no secret header at all');
    assert.equal(resolveExtensionUserId(fakeRequest({ 'X-Extension-User-Id': '7', 'X-Extension-Secret': 'wrong' }), null), null, 'wrong secret');
    assert.equal(resolveExtensionUserId(fakeRequest({ 'X-Extension-User-Id': '7', 'X-Extension-Secret': 'correct-secret' }), null), 7, 'right secret');
  } finally {
    if (prev !== undefined) process.env.EXTENSION_SHARED_SECRET = prev; else delete process.env.EXTENSION_SHARED_SECRET;
  }
});
