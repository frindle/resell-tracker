'use strict';

const { test } = require('node:test');
const assert = require('assert');
const load0 = () => require('./src/trackingQueue.js');

test('planTrackingVisits returns seed URLs when no visited and no cap limit', () => {
  const { planTrackingVisits } = load0();
  const seed = ['https://track.example.com/abc', 'https://track.example.com/def'];
  const discovered = [];
  const visited = new Set();
  const result = planTrackingVisits(seed, discovered, visited, 10);
  assert.strictEqual(result.length, 2, 'should return both seed URLs');
  assert.deepStrictEqual(result, ['https://track.example.com/abc', 'https://track.example.com/def']);
});

test('planTrackingVisits excludes visited URLs and respects cap', () => {
  const { planTrackingVisits } = load0();
  const seed = ['https://track.example.com/aaa', 'https://track.example.com/bbb', 'https://track.example.com/ccc'];
  const discovered = ['https://track.example.com/ddd', 'https://track.example.com/eee'];
  const visited = new Set(['https://track.example.com/aaa']);
  const cap = 4;
  const result = planTrackingVisits(seed, discovered, visited, cap);
  // visited has 1 item, cap is 4, so max new = 4 - 1 = 3
  // seed: aaa (in visited, skip), bbb, ccc -> 2 candidates
  // discovered: ddd, eee -> 2 more
  // total candidates = 4, but cap allows only 3
  assert.strictEqual(result.length, 3, 'should return at most cap - visited.size = 3');
  assert.strictEqual(result[0], 'https://track.example.com/bbb');
  assert.strictEqual(result[1], 'https://track.example.com/ccc');
  assert.strictEqual(result[2], 'https://track.example.com/ddd');
});

test('planTrackingVisits filters out non-string and empty entries', () => {
  const { planTrackingVisits } = load0();
  const seed = ['https://valid.com/a', null, undefined, '', 42, false];
  const discovered = [null, 'https://valid.com/b'];
  const visited = new Set();
  const result = planTrackingVisits(seed, discovered, visited, 10);
  assert.strictEqual(result.length, 2, 'should only include valid string URLs');
  assert.deepStrictEqual(result, ['https://valid.com/a', 'https://valid.com/b']);
});

test('planTrackingVisits returns [] when cap is already reached', () => {
  const { planTrackingVisits } = load0();
  const seed = ['https://track.example.com/x'];
  const discovered = [];
  const visited = new Set(['https://track.example.com/x']);
  const cap = 1;
  const result = planTrackingVisits(seed, discovered, visited, cap);
  assert.strictEqual(result.length, 0, 'should return empty when all visited and cap reached');
});

test('planTrackingVisits deduplicates seed and discovered across both', () => {
  const { planTrackingVisits } = load0();
  const seed = ['https://track.example.com/dup'];
  const discovered = ['https://track.example.com/dup', 'https://track.example.com/other'];
  const visited = new Set();
  const result = planTrackingVisits(seed, discovered, visited, 10);
  assert.strictEqual(result.length, 2, 'should deduplicate across seed and discovered');
  assert.deepStrictEqual(result, ['https://track.example.com/dup', 'https://track.example.com/other']);
});

test('planTrackingVisits handles null/undefined seed and discovered as empty', () => {
  const { planTrackingVisits } = load0();
  const result = planTrackingVisits(null, undefined, new Set(), 5);
  assert.strictEqual(result.length, 0, 'null seed and undefined discovered should yield empty');
});
