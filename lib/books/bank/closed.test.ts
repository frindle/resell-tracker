import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closedOnRefusal, checkDueForMonth, isPostClose, leftoverCents, leftoverMessage, closedLast, closedLabel } from './closed.ts';

test('closedOn: a real day, not in the future, not before the last posted row', () => {
  assert.equal(closedOnRefusal('2027-03-15', '2027-03-10'), null);
  assert.equal(closedOnRefusal('2027-03-10', '2027-03-10'), null);
  assert.equal(closedOnRefusal('2027-03-15', null), null);
  assert.match(closedOnRefusal('2027-03-09', '2027-03-10') ?? '', /before the last posted/);
  assert.match(closedOnRefusal('2027-02-30', null) ?? '', /real date/);
  assert.match(closedOnRefusal('March', null) ?? '', /YYYY-MM-DD/);
  assert.match(closedOnRefusal(20270315, null) ?? '', /YYYY-MM-DD/);
});

test('a month-end check is due up to and including the month of closedOn', () => {
  assert.equal(checkDueForMonth(null, '2030-01'), true);
  assert.equal(checkDueForMonth('2027-03-15', '2027-02'), true);
  assert.equal(checkDueForMonth('2027-03-15', '2027-03'), true);
  assert.equal(checkDueForMonth('2027-03-15', '2027-04'), false);
});

test('rows after closedOn are post-close; rows on or before are not', () => {
  assert.equal(isPostClose(null, '2027-09-01'), false);
  assert.equal(isPostClose('2027-03-15', '2027-03-15'), false);
  assert.equal(isPostClose('2027-03-15', '2027-03-16'), true);
});

test('leftover: last balance plus settled rows after its date; message only when not zero', () => {
  const rows = [{ postedDate: '2027-03-12', amountCents: -2500, pending: false }, { postedDate: '2027-03-13', amountCents: -100, pending: true }, { postedDate: '2027-03-01', amountCents: 999, pending: false }];
  assert.equal(leftoverCents(null, null, rows), null);
  assert.equal(leftoverCents(10000, '2027-03-10', rows), 7500);
  assert.equal(leftoverCents(10000, '2027-03-10', rows, '2027-03-11'), 10000); // the row after the close is held out
  assert.equal(leftoverMessage(7500), 'closed with $75.00 left - record where it went');
  assert.equal(leftoverMessage(-1234), 'closed with -$12.34 left - record where it went');
  assert.equal(leftoverMessage(0), null);
  assert.equal(leftoverMessage(null), null);
});

test('pickers: closed last, marked (closed)', () => {
  const l = closedLast([{ n: 'a', closedOn: '2027-01-01' }, { n: 'b' }, { n: 'c', closedOn: null }]);
  assert.deepEqual(l.map(x => x.n), ['b', 'c', 'a']);
  assert.equal(closedLabel('Checking', '2027-01-01'), 'Checking (closed)');
  assert.equal(closedLabel('Checking', null), 'Checking');
});
