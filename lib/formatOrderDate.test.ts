/**
 * Tests for how an order's date is shown and edited.
 *
 *   npm run test:order-date
 *
 * No test framework is installed in this repo, so these run on Node's built-in
 * runner with type stripping.
 *
 * These run under TZ=America/Los_Angeles (set by the npm script). The bug they
 * exist for only appears west of UTC: an imported date-only order stored as
 * 2026-06-19T00:00:00.000Z is 2026-06-18 5:00 pm in Pacific, so the orders
 * list (UTC extraction) said 6/19 while the edit form (local getters) said
 * 6/18 5:00 pm for the same row. Running these in UTC would pass vacuously,
 * so the offset is asserted up front.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  formatOrderDate,
  formatOrderDateIso,
  toOrderDateInputValue,
  fromOrderDateInputValue,
  isDateOnlyOrderDate,
} from './formatOrderDate.ts';

test('the test environment is actually west of UTC', () => {
  assert.ok(
    new Date('2026-06-19T00:00:00.000Z').getTimezoneOffset() > 0,
    'run these with TZ=America/Los_Angeles — in UTC they cannot fail',
  );
});

// --- a date-only (bulk-imported) order -----------------------------------
// The exact shape of the order Penn reported: 6/19 in the list, 6/18 5pm in
// the detail form.
const DATE_ONLY = '2026-06-19T00:00:00.000Z';

test('a date-only order keeps its imported calendar day', () => {
  assert.equal(isDateOnlyOrderDate(DATE_ONLY), true);
  assert.equal(formatOrderDate(DATE_ONLY, { dateOnly: true }), '06/19/2026');
  assert.equal(formatOrderDateIso(DATE_ONLY), '2026-06-19');
});

test('a date-only order shows no invented time, even when time is requested', () => {
  assert.equal(formatOrderDate(DATE_ONLY), '06/19/2026');
});

test('the list and the edit form agree on the day for a date-only order', () => {
  const listed = formatOrderDate(DATE_ONLY, { dateOnly: true });          // orders table
  const edited = toOrderDateInputValue(DATE_ONLY);                        // OrderForm input
  assert.equal(edited, '2026-06-19T00:00');
  const [y, m, d] = edited.slice(0, 10).split('-');
  assert.equal(listed, `${m}/${d}/${y}`);
});

test('opening and saving a date-only order without touching it does not move it', () => {
  assert.equal(fromOrderDateInputValue(toOrderDateInputValue(DATE_ONLY)), DATE_ONLY);
});

// --- a real timestamp -----------------------------------------------------
// 2026-06-20T17:30Z is 10:30 am PDT.
const TIMESTAMPED = '2026-06-20T17:30:00.000Z';

test('a real timestamp is shown in local time', () => {
  assert.equal(isDateOnlyOrderDate(TIMESTAMPED), false);
  assert.equal(formatOrderDate(TIMESTAMPED), '06/20/2026 10:30 am');
  assert.equal(formatOrderDate(TIMESTAMPED, { dateOnly: true }), '06/20/2026');
  assert.equal(formatOrderDateIso(TIMESTAMPED), '2026-06-20');
});

test('the list and the edit form agree on the day for a real timestamp', () => {
  assert.equal(toOrderDateInputValue(TIMESTAMPED), '2026-06-20T10:30');
  assert.equal(formatOrderDate(TIMESTAMPED, { dateOnly: true }), '06/20/2026');
});

test('a real timestamp round-trips through the edit form unchanged', () => {
  assert.equal(fromOrderDateInputValue(toOrderDateInputValue(TIMESTAMPED)), TIMESTAMPED);
});

// --- near local midnight --------------------------------------------------
test('an order just after local midnight stays on the new day', () => {
  const justAfter = '2026-06-20T07:15:00.000Z'; // 00:15 PDT on the 20th
  assert.equal(formatOrderDate(justAfter, { dateOnly: true }), '06/20/2026');
  assert.equal(toOrderDateInputValue(justAfter), '2026-06-20T00:15');
  assert.equal(fromOrderDateInputValue(toOrderDateInputValue(justAfter)), justAfter);
});

test('an order just before local midnight stays on the old day', () => {
  const justBefore = '2026-06-20T06:30:00.000Z'; // 23:30 PDT on the 19th
  assert.equal(formatOrderDate(justBefore, { dateOnly: true }), '06/19/2026');
  assert.equal(toOrderDateInputValue(justBefore), '2026-06-19T23:30');
  assert.equal(fromOrderDateInputValue(toOrderDateInputValue(justBefore)), justBefore);
});

// --- no imported date may drift, on any day of the year -------------------
test('a bare imported date never shifts a day, including across DST', () => {
  const start = Date.UTC(2026, 0, 1);
  for (let i = 0; i < 400; i++) {
    const day = new Date(start + i * 86_400_000).toISOString().slice(0, 10);
    const stored = `${day}T00:00:00.000Z`;
    assert.equal(formatOrderDateIso(stored), day, `ISO drifted on ${day}`);
    const [y, m, d] = day.split('-');
    assert.equal(formatOrderDate(stored, { dateOnly: true }), `${m}/${d}/${y}`, `display drifted on ${day}`);
    assert.equal(toOrderDateInputValue(stored), `${day}T00:00`, `input drifted on ${day}`);
    assert.equal(fromOrderDateInputValue(`${day}T00:00`), stored, `save drifted on ${day}`);
  }
});

// --- input shapes ---------------------------------------------------------
test('a bare YYYY-MM-DD (the delivery-deadline input) saves as that UTC day', () => {
  assert.equal(fromOrderDateInputValue('2026-08-25'), '2026-08-25T00:00:00.000Z');
});

test('an empty or unparseable value is passed through, not turned into NaN', () => {
  assert.equal(fromOrderDateInputValue(''), '');
  assert.equal(fromOrderDateInputValue('not a date'), 'not a date');
  assert.equal(formatOrderDate('not a date'), 'not a date');
  assert.equal(formatOrderDateIso('not a date'), 'not a date');
  assert.equal(toOrderDateInputValue('not a date'), '');
});

test('a Date object is accepted wherever a string is', () => {
  assert.equal(formatOrderDate(new Date(DATE_ONLY), { dateOnly: true }), '06/19/2026');
  assert.equal(toOrderDateInputValue(new Date(TIMESTAMPED)), '2026-06-20T10:30');
});
