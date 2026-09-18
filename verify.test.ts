// Model-drafted; NOT yet read by a human.
const DRAFT_UNCONFIRMED = true;

// Adversarial repo-style test for: cc-waitlist-r2-s4-on   (node --test / tsx --test)
//
// Pins the boundary (today == maxDate is STILL eligible), both hook directions,
// the waiting bucket, and the failure paths (throwing hooks, malformed card).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { decideWaitlist, runWaitlist, type WaitlistCard } from './lib/ccWaitlist';

const card = (id: number, minDate: string | null, maxDate: string): WaitlistCard => ({ id, minDate, maxDate });
const track = () => ({ submitted: [] as number[], expired: [] as number[] });
const hooksFor = (t: { submitted: number[]; expired: number[] }) => ({
  submit: (c: WaitlistCard) => t.submitted.push(c.id),
  onExpire: (c: WaitlistCard) => t.expired.push(c.id),
});

test('boundary: today == maxDate is still eligible and submits', async () => {
  const c = card(7, null, '2026-03-15');
  assert.equal(decideWaitlist(c, '2026-03-15'), 'SUBMIT');
  const t = track();
  const s = await runWaitlist([c], '2026-03-15', hooksFor(t));
  assert.deepEqual(s.submitted, [7]);
  assert.deepEqual(s.waiting, []);
  assert.deepEqual(s.expired, []);
  assert.deepEqual(s.errors, []);
  assert.deepEqual(t.submitted, [7]);   // submit hook fired exactly once
  assert.deepEqual(t.expired, []);      // onExpire must NOT fire on the boundary day
});

test('one day past maxDate expires and is surfaced via onExpire', async () => {
  const c = card(8, null, '2026-03-15');
  assert.equal(decideWaitlist(c, '2026-03-16'), 'EXPIRE');
  const t = track();
  const s = await runWaitlist([c], '2026-03-16', hooksFor(t));
  assert.deepEqual(s.expired, [8]);
  assert.deepEqual(s.submitted, []);
  assert.deepEqual(s.errors, []);
  assert.deepEqual(t.expired, [8]);     // onExpire fired with the lapsed card
  assert.deepEqual(t.submitted, []);    // submit must NOT fire once expired
});

test('minDate boundary submits; a future window waits and fires no hook', async () => {
  const atMin = card(31, '2026-04-01', '2026-04-30');   // today == minDate -> SUBMIT
  const notYet = card(32, '2026-05-01', '2026-05-31');  // window starts later -> WAITING
  assert.equal(decideWaitlist(atMin, '2026-04-01'), 'SUBMIT');
  assert.equal(decideWaitlist(notYet, '2026-04-01'), 'WAITING');
  const t = track();
  const s = await runWaitlist([atMin, notYet], '2026-04-01', hooksFor(t));
  assert.deepEqual(s.submitted, [31]);
  assert.deepEqual(s.waiting, [32]);
  assert.deepEqual(s.expired, []);
  assert.deepEqual(s.errors, []);
  assert.deepEqual(t.submitted, [31]);
  assert.deepEqual(t.expired, []);     // WAITING triggers neither hook
});

test('a throwing submit is recorded as an error and the run continues', async () => {
  const a = card(41, null, '2026-06-30');
  const b = card(42, null, '2026-06-30');
  let calls = 0;
  const s = await runWaitlist([a, b], '2026-06-15', {
    submit: (c) => { calls++; if (c.id === 41) throw new Error('submit failed'); },
    onExpire: () => {},
  });
  assert.equal(calls, 2);                       // runner did not stop at the first failure
  assert.deepEqual(s.submitted, [42]);          // the failing card is NOT counted submitted
  assert.equal(s.errors.length, 1);
  assert.equal(s.errors[0].id, 41);
  assert.equal(s.errors[0].message, 'submit failed');
});

test('a throwing onExpire is recorded; non-Error throws are stringified', async () => {
  const c = card(51, null, '2026-01-31');
  const s = await runWaitlist([c], '2026-02-01', {
    submit: () => {},
    onExpire: () => { throw 'expired-hook-down'; },
  });
  assert.deepEqual(s.expired, []);              // hook failed -> not counted expired
  assert.equal(s.errors.length, 1);
  assert.equal(s.errors[0].id, 51);
  assert.equal(s.errors[0].message, 'expired-hook-down');
});

test('a malformed card becomes an error entry instead of throwing', async () => {
  const good = card(61, null, '2026-07-31');
  const bad = {} as WaitlistCard;               // no id, no maxDate
  const t = track();
  const s = await runWaitlist([bad, good], '2026-07-01', hooksFor(t));
  assert.equal(s.errors.length, 1);
  assert.equal(s.errors[0].id, null);           // no id to report
  assert.ok(typeof s.errors[0].message === 'string' && s.errors[0].message.length > 0);
  assert.deepEqual(s.submitted, [61]);          // the valid card after it still submits
});
