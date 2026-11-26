import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withKeyedLock } from './keyedLock.ts';

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

test('keyedLock: work on one key runs one at a time, in order', async () => {
  const log: string[] = [];
  let value = 0;
  const add = (name: string, ms: number) => withKeyedLock('k', async () => {
    const seen = value;
    log.push(`${name} start`);
    await wait(ms);
    value = seen + 1;
    log.push(`${name} end`);
  });
  await Promise.all([add('a', 20), add('b', 1), add('c', 5)]);
  assert.equal(value, 3);
  assert.deepEqual(log, ['a start', 'a end', 'b start', 'b end', 'c start', 'c end']);
});

test('keyedLock: a failure is passed on and does not block the next', async () => {
  const bad = withKeyedLock('f', async () => { throw new Error('boom'); });
  const good = withKeyedLock('f', async () => 'ok');
  await assert.rejects(bad, /boom/);
  assert.equal(await good, 'ok');
});

test('keyedLock: different keys do not wait for each other', async () => {
  const log: string[] = [];
  await Promise.all([
    withKeyedLock('x', async () => { await wait(20); log.push('x'); }),
    withKeyedLock('y', async () => { log.push('y'); }),
  ]);
  assert.deepEqual(log, ['y', 'x']);
});
