import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalCommandPayload, extensionCommandDedupeWhere, retryDedupeWhere, egiftRealPayloadForms } from './extensionCommandDedupe.ts';
import {
  egiftRunnerMode, resetEgiftRunnerWarning, realEgiftPayload, dryRunEgiftPayload, onEgiftCommandEnded, shadowLine, compareEgiftRuns, readEgiftResult,
  type ShadowDeps, type EgiftRunnerMode,
} from './egiftRunner.ts';

const canon = (p: unknown) => JSON.stringify(canonicalCommandPayload('SCRAPE_EGIFT', p));

test('canonical payload keeps runner plan and dryRun only with plan, in fixed key order', () => {
  assert.equal(canon({ orderId: 5 }), '{"orderId":5}');
  assert.equal(canon({ runner: 'plan', orderId: 5 }), '{"orderId":5,"runner":"plan"}');
  assert.equal(canon({ dryRun: true, runner: 'plan', orderId: 5 }), '{"orderId":5,"runner":"plan","dryRun":true}');
  assert.equal(canon({ orderId: 5, dryRun: true }), '{"orderId":5}');
  assert.equal(canon({ orderId: 5, runner: 'builtin', dryRun: true, link: 'x', email: 'y' }), '{"orderId":5}');
  assert.equal(canon({ orderId: 5, runner: 'plan', dryRun: 'yes', extra: 1 }), '{"orderId":5,"runner":"plan"}');
});

test('EGIFT_RUNNER modes: default shadow, builtin, plan, unknown = builtin with one warning', () => {
  resetEgiftRunnerWarning();
  const warns: string[] = [];
  const w = (m: string) => warns.push(m);
  assert.equal(egiftRunnerMode(undefined, w), 'shadow');
  assert.equal(egiftRunnerMode('', w), 'shadow');
  assert.equal(egiftRunnerMode('builtin', w), 'builtin');
  assert.equal(egiftRunnerMode('shadow', w), 'shadow');
  assert.equal(egiftRunnerMode('plan', w), 'plan');
  assert.equal(warns.length, 0);
  assert.equal(egiftRunnerMode('bogus', w), 'builtin');
  assert.equal(egiftRunnerMode('other', w), 'builtin');
  assert.equal(warns.length, 1);
});

test('real payload per mode', () => {
  assert.deepEqual(realEgiftPayload(3, 'builtin'), { orderId: 3 });
  assert.deepEqual(realEgiftPayload(3, 'shadow'), { orderId: 3 });
  assert.deepEqual(realEgiftPayload(3, 'plan'), { orderId: 3, runner: 'plan' });
  assert.equal(canon(dryRunEgiftPayload(3)), '{"orderId":3,"runner":"plan","dryRun":true}');
});

function harness(mode: EgiftRunnerMode, builtinResult: string | null = '{"cards":2,"saved":2}') {
  const st = { dry: new Set<number>(), queued: [] as number[], logs: [] as string[] };
  const deps: ShadowDeps = {
    mode,
    hasDryRun: async id => st.dry.has(id),
    queueDryRun: async id => { st.dry.add(id); st.queued.push(id); },
    findBuiltinResult: async () => builtinResult,
    log: l => st.logs.push(l),
  };
  return { st, deps };
}
const real = (status: string, payload = '{"orderId":9}') => ({ type: 'SCRAPE_EGIFT', payload, status, result: null });

test('shadow: one dry run after a done real run, never a second', async () => {
  const { st, deps } = harness('shadow');
  assert.equal(await onEgiftCommandEnded(real('done'), deps), 'queued');
  assert.equal(await onEgiftCommandEnded(real('done'), deps), 'none');
  assert.deepEqual(st.queued, [9]);
});

test('no dry run after a failed real run, in builtin or plan mode, or for a plan-form real run', async () => {
  for (const [mode, cmd] of [['shadow', real('failed')], ['builtin', real('done')], ['plan', real('done')], ['shadow', real('done', '{"orderId":9,"runner":"plan"}')]] as const) {
    const { st, deps } = harness(mode);
    assert.equal(await onEgiftCommandEnded(cmd, deps), 'none');
    assert.deepEqual(st.queued, []);
  }
});

test('a finished dry run logs one comparison line, counts and codes only', async () => {
  const dry = (status: string, result: string) => ({ type: 'SCRAPE_EGIFT', payload: '{"orderId":9,"runner":"plan","dryRun":true}', status, result });
  let h = harness('shadow');
  assert.equal(await onEgiftCommandEnded(dry('done', '{"cards":2,"saved":0,"runner":"plan v3","trace":[]}'), h.deps), 'compared');
  assert.deepEqual(h.st.logs, ['[egift-shadow] order=9 builtin=2 plan=2 match plan_runner=plan_v3']);
  h = harness('shadow');
  await onEgiftCommandEnded(dry('done', '{"cards":1,"saved":0,"runner":"plan v3"}'), h.deps);
  assert.equal(h.st.logs[0], '[egift-shadow] order=9 builtin=2 plan=1 MISMATCH plan_runner=plan_v3');
  h = harness('shadow');
  await onEgiftCommandEnded(dry('failed', '{"cards":0,"saved":0,"error":"bot-check","runner":"plan v3"}'), h.deps);
  assert.equal(h.st.logs[0], '[egift-shadow] order=9 builtin=2 plan=0 MISMATCH plan_runner=plan_v3 bot-check');
});

test('comparison line leaks nothing but sanitised codes', () => {
  const r = readEgiftResult('failed', JSON.stringify({ cards: 1, error: 'https://x.test/?login=SECRET', runner: 'a b' }));
  assert.match(shadowLine(compareEgiftRuns(1, null, r)), /^\[egift-shadow\] order=1 builtin=\? plan=1 MISMATCH plan_runner=a_b [A-Za-z0-9._-]{1,48}$/);
});

test('dedupe treats built-in and plan forms of the real command as one order, and never matches a dry run', () => {
  const forms = egiftRealPayloadForms(4);
  for (const p of [{ orderId: 4 }, { orderId: 4, runner: 'plan' }]) {
    assert.deepEqual(extensionCommandDedupeWhere('SCRAPE_EGIFT', 'chrome', p).payload, { in: forms });
  }
  assert.ok(!forms.includes(canon({ orderId: 4, runner: 'plan', dryRun: true })));
  assert.equal(extensionCommandDedupeWhere('SCRAPE_EGIFT', 'chrome', { orderId: 4, runner: 'plan', dryRun: true }).payload, '{"orderId":4,"runner":"plan","dryRun":true}');
  assert.deepEqual(retryDedupeWhere('SCRAPE_EGIFT', 'chrome', '{"orderId":4,"runner":"plan"}').payload, { in: forms });
});
