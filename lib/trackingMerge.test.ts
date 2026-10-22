import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeTracking } from './trackingMerge.ts';

test('incomplete=true unions existing and incoming, preserving order', () => {
  const result = mergeTracking('A1,B2', 'B2,C3', true);
  assert.equal(result.list, 'A1,B2,C3');
  assert.equal(result.added, true);
});

test('incomplete=false keeps incoming list with added=true when new item present', () => {
  const result = mergeTracking('A1', 'A1,B2', false);
  assert.equal(result.list, 'A1,B2');
  assert.equal(result.added, true);
});

test('case-insensitive match: same number different case gives added=false, keeps incoming casing (replace mode)', () => {
  const result = mergeTracking('A1', 'a1', false);
  assert.equal(result.list, 'a1');
  assert.equal(result.added, false);
});

test('replace mode drops a stored number the scrape no longer lists, added=false', () => {
  const result = mergeTracking('A1,B2', 'b2', false);
  assert.equal(result.list, 'b2');
  assert.equal(result.added, false);
});

test('incomplete=true: incoming duplicates within itself and case-only diffs give added=false', () => {
  const result = mergeTracking('A1,B2', 'b2,a1,B2', true);
  assert.equal(result.list, 'A1,B2');
  assert.equal(result.added, false);
});

test('replace mode de-duplicates incoming case-insensitively, first occurrence wins', () => {
  const result = mergeTracking(null, 'x9,X9,Y8', false);
  assert.equal(result.list, 'x9,Y8');
  assert.equal(result.added, true);
});

test('incomplete=false with empty incoming keeps existing list unchanged', () => {
  const result = mergeTracking('A1,B2', '', false);
  assert.equal(result.list, 'A1,B2');
  assert.equal(result.added, false);
});

test('null inputs behave as empty', () => {
  const result = mergeTracking(null, null, true);
  assert.equal(result.list, '');
  assert.equal(result.added, false);
});

test('incomplete=true deduplicates case-insensitively, keeping existing casing for duplicates', () => {
  const result = mergeTracking('A1,b2', 'a1,C3', true);
  assert.equal(result.list, 'A1,b2,C3');
  assert.equal(result.added, true);
});

test('pure reorder of existing items gives added=false', () => {
  const result = mergeTracking('A1,B2', 'B2,A1', false);
  assert.equal(result.list, 'B2,A1');
  assert.equal(result.added, false);
});

test('spaces around commas are trimmed', () => {
  const result = mergeTracking('A1 , B2', ' C3 ,A1 ', false);
  assert.equal(result.list, 'C3,A1');
  assert.equal(result.added, true);
});

test('empty parts from trailing commas are dropped', () => {
  const result = mergeTracking('A1,,B2', 'C3,', false);
  assert.equal(result.list, 'C3');
  assert.equal(result.added, true);
});
