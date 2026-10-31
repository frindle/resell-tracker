/**
 *   node --experimental-strip-types --test lib/bfmrWebRetry.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchTrackerWithRelogin, isTracker401, BfmrWebSessionExpiredError } from './bfmrWebRetry.ts';

const e401 = () => new Error('BFMR fetch tracker 401');

function harness(opts: { fetch: (s: string, n: number) => Promise<string[]>; sessions?: Array<string | Error> }) {
  const calls = { getSession: 0, dropSession: 0, fetchRows: 0 };
  const sessions = opts.sessions ?? ['old', 'new'];
  return {
    calls,
    deps: {
      getSession: async () => {
        const s = sessions[Math.min(calls.getSession++, sessions.length - 1)];
        if (s instanceof Error) throw s;
        return s;
      },
      dropSession: async () => { calls.dropSession++; },
      fetchRows: async (s: string) => opts.fetch(s, ++calls.fetchRows),
    },
  };
}

test('isTracker401 matches only the tracker 401 error', () => {
  assert.equal(isTracker401(e401()), true);
  assert.equal(isTracker401(new Error('BFMR fetch tracker 403')), false);
  assert.equal(isTracker401(new Error('BFMR fetch tracker 500')), false);
  assert.equal(isTracker401('BFMR fetch tracker 401'), false);
  assert.equal(isTracker401(null), false);
});

test('success on first try: no drop, no retry', async () => {
  const h = harness({ fetch: async () => ['row'] });
  assert.deepEqual(await fetchTrackerWithRelogin(h.deps), ['row']);
  assert.deepEqual(h.calls, { getSession: 1, dropSession: 0, fetchRows: 1 });
});

test('401 then success: drops session, re-logs in once, retries with the NEW session', async () => {
  const seen: string[] = [];
  const h = harness({
    fetch: async (s, n) => { seen.push(s); if (n === 1) throw e401(); return ['fresh']; },
  });
  assert.deepEqual(await fetchTrackerWithRelogin(h.deps), ['fresh']);
  assert.deepEqual(seen, ['old', 'new']);
  assert.deepEqual(h.calls, { getSession: 2, dropSession: 1, fetchRows: 2 });
});

test('401 then login fails (403 captcha): typed session-expired error, no second fetch', async () => {
  const h = harness({
    sessions: ['old', new Error('BFMR web login 403: captcha')],
    fetch: async () => { throw e401(); },
  });
  await assert.rejects(fetchTrackerWithRelogin(h.deps), (err: unknown) => {
    assert.ok(err instanceof BfmrWebSessionExpiredError);
    assert.equal((err as Error).message, 'BFMR web session expired - re-login needed');
    assert.ok(String(err).includes('re-login needed'));
    return true;
  });
  assert.equal(h.calls.dropSession, 1);
  assert.equal(h.calls.fetchRows, 1);
});

test('401 twice: retried exactly once, then typed session-expired error', async () => {
  const h = harness({ fetch: async () => { throw e401(); } });
  await assert.rejects(fetchTrackerWithRelogin(h.deps), BfmrWebSessionExpiredError);
  assert.deepEqual(h.calls, { getSession: 2, dropSession: 1, fetchRows: 2 });
});

test('non-401 errors propagate untouched with no drop or retry', async () => {
  const boom = new Error('BFMR fetch tracker 500');
  const h = harness({ fetch: async () => { throw boom; } });
  await assert.rejects(fetchTrackerWithRelogin(h.deps), (err: unknown) => err === boom);
  assert.deepEqual(h.calls, { getSession: 1, dropSession: 0, fetchRows: 1 });
});

test('non-401 error on the retry propagates as-is', async () => {
  const boom = new Error('BFMR fetch tracker 500');
  const h = harness({ fetch: async (_s, n) => { throw n === 1 ? e401() : boom; } });
  await assert.rejects(fetchTrackerWithRelogin(h.deps), (err: unknown) => err === boom);
  assert.equal(h.calls.fetchRows, 2);
});

test('initial getSession failure propagates unchanged (existing behaviour)', async () => {
  const bad = new Error('BFMR web login 403: captcha');
  const h = harness({ sessions: [bad], fetch: async () => ['x'] });
  await assert.rejects(fetchTrackerWithRelogin(h.deps), (err: unknown) => err === bad);
  assert.equal(h.calls.fetchRows, 0);
});
