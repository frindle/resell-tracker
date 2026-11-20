/**
 * Tests for the DR primary flag gate.
 *
 *   npm run test:primary-flag
 *
 * The DNS lookup is faked; nothing here touches the network.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTxt, parseRole, readFlag, createGate, type Deps } from './primaryFlag.ts';

type Answer = string | 'down' | 'nxdomain' | 'bad-json';

function mkDeps(answers: Record<string, Answer>, role: 'home' | 'cloud' = 'home', clock = { t: 1_000_000 }) {
  const logs: string[] = [];
  const calls: string[] = [];
  const deps: Deps = {
    resolvers: Object.keys(answers),
    name: '_dr-primary.example.test',
    timeoutMs: 50,
    ttlMs: 60_000,
    role,
    now: () => clock.t,
    log: l => logs.push(l),
    fetch: async (url) => {
      const base = url.split('?')[0];
      calls.push(url);
      const a = answers[base];
      if (a === 'down') throw new Error('network down');
      if (a === 'bad-json') return { ok: true, json: async () => { throw new Error('not json'); } };
      if (a === 'nxdomain') return { ok: true, json: async () => ({ Status: 3 }) };
      return { ok: true, json: async () => ({ Status: 0, Answer: [{ type: 16, data: a }] }) };
    },
  };
  return { deps, logs, calls, clock, set: (r: string, a: Answer) => { answers[r] = a; } };
}
const A = 'https://r1.test/q', B = 'https://r2.test/q';

test('parseTxt reads plain, quoted and since= values', () => {
  assert.deepEqual(parseTxt('home'), { value: 'home', since: 0 });
  assert.deepEqual(parseTxt('"cloud;since=1700000000"'), { value: 'cloud', since: 1700000000 });
  assert.deepEqual(parseTxt('"clo" "ud"'), { value: 'cloud', since: 0 });
  assert.deepEqual(parseTxt(' "HOME ; since=5" '), { value: 'home', since: 5 });
  assert.equal(parseTxt('"maybe"'), null);
  assert.equal(parseTxt(''), null);
});

test('parseRole defaults to home', () => {
  assert.equal(parseRole(undefined), 'home');
  assert.equal(parseRole('cloud'), 'cloud');
  assert.equal(parseRole('garbage'), 'home');
});

test('readFlag: both resolvers agree', async () => {
  const { deps } = mkDeps({ [A]: '"cloud"', [B]: '"cloud"' });
  assert.deepEqual(await readFlag(deps), { value: 'cloud' });
});

test('readFlag: one resolver down, the other answers', async () => {
  const { deps } = mkDeps({ [A]: 'down', [B]: '"home"' });
  assert.deepEqual(await readFlag(deps), { value: 'home' });
});

test('readFlag: all down, no record or bad data is unknown', async () => {
  assert.deepEqual(await readFlag(mkDeps({ [A]: 'down', [B]: 'down' }).deps), { value: 'unknown' });
  assert.deepEqual(await readFlag(mkDeps({ [A]: 'nxdomain', [B]: 'bad-json' }).deps), { value: 'unknown' });
  assert.deepEqual(await readFlag(mkDeps({ [A]: '"nonsense"', [B]: '"nonsense"' }).deps), { value: 'unknown' });
});

test('readFlag: disagreement resolved by higher since, a tie is unknown', async () => {
  assert.deepEqual(await readFlag(mkDeps({ [A]: '"home;since=100"', [B]: '"cloud;since=200"' }).deps), { value: 'cloud' });
  assert.deepEqual(await readFlag(mkDeps({ [A]: '"home"', [B]: '"cloud"' }).deps), { value: 'unknown' });
  assert.deepEqual(await readFlag(mkDeps({ [A]: '"home;since=7"', [B]: '"cloud;since=7"' }).deps), { value: 'unknown' });
});

test('gate: home instance runs on home, skips on cloud', async () => {
  const h = mkDeps({ [A]: '"home"', [B]: '"home"' }, 'home');
  const g = createGate(h.deps);
  assert.equal((await g.decide('job')).run, true);
  const c = mkDeps({ [A]: '"home"', [B]: '"home"' }, 'cloud');
  const gc = createGate(c.deps);
  assert.equal((await gc.decide('job')).run, false);
  assert.match(c.logs[0], /skip job: flag=home \(live\), this instance=cloud/);
});

test('gate: never read means home', async () => {
  const home = createGate(mkDeps({ [A]: 'down', [B]: 'down' }, 'home').deps);
  const d = await home.decide('j');
  assert.deepEqual([d.run, d.flag, d.source], [true, 'home', 'assumed']);
  const cloud = createGate(mkDeps({ [A]: 'down', [B]: 'down' }, 'cloud').deps);
  assert.equal((await cloud.decide('j')).run, false);
});

test('gate: unknown uses the cached value', async () => {
  const m = mkDeps({ [A]: '"cloud"', [B]: '"cloud"' }, 'cloud');
  const g = createGate(m.deps);
  assert.equal((await g.decide('j')).run, true);
  m.set(A, 'down'); m.set(B, 'down');
  m.clock.t += 10 * 60_000;                      // past the cache window, lookup now fails
  const d = await g.decide('j');
  assert.deepEqual([d.run, d.flag, d.source], [true, 'cloud', 'cached']);
  m.set(A, '"home"'); m.set(B, '"home"');
  m.clock.t += 10 * 60_000;
  assert.equal((await g.decide('j')).run, false); // a fresh read wins over the cache
});

test('gate: lookups are cached within the window and shared in flight', async () => {
  const m = mkDeps({ [A]: '"home"', [B]: '"home"' });
  const g = createGate(m.deps);
  await Promise.all([g.decide('a'), g.decide('b'), g.decide('c')]);
  assert.equal(m.calls.length, 2);               // one lookup, two resolvers
  await g.decide('d');
  assert.equal(m.calls.length, 2);
  m.clock.t += 61_000;
  await g.decide('e');
  assert.equal(m.calls.length, 4);
});

test('gate: skip log is throttled per job', async () => {
  const m = mkDeps({ [A]: '"home"', [B]: '"home"' }, 'cloud');
  const g = createGate(m.deps);
  await g.decide('x'); await g.decide('x'); await g.decide('y');
  assert.equal(m.logs.length, 2);
  m.clock.t += 31 * 60_000;
  await g.decide('x');
  assert.equal(m.logs.length, 3);
  assert.ok(m.logs.every(l => !/https?:|\d+\.\d+\.\d+\.\d+/.test(l)));
});

test('gated() runs the job only on the primary side and passes arguments', async () => {
  const seen: number[] = [];
  const home = createGate(mkDeps({ [A]: '"home"', [B]: '"home"' }, 'home').deps);
  await home.gated('j', (n: number) => { seen.push(n); })(7);
  const cloud = createGate(mkDeps({ [A]: '"home"', [B]: '"home"' }, 'cloud').deps);
  await cloud.gated('j', (n: number) => { seen.push(n); })(8);
  assert.deepEqual(seen, [7]);
});

test('gated() job errors still surface to the caller', async () => {
  const g = createGate(mkDeps({ [A]: '"home"', [B]: '"home"' }).deps);
  await assert.rejects(g.gated('j', () => { throw new Error('boom'); })(), /boom/);
});

test('a failing lookup never throws out of the gate', async () => {
  const m = mkDeps({ [A]: 'down', [B]: 'down' }, 'home');
  m.deps.fetch = async () => { throw new TypeError('x'); };
  const g = createGate(m.deps);
  await g.gated('j', () => {})();
});
