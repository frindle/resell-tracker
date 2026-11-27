// Which runner the extension uses for SCRAPE_EGIFT, and the shadow-mode proof of the step-plan runner.
//
//   builtin  today's behaviour: payload {orderId}.
//   shadow   (default) the real command stays the built-in one and still saves the cards. When it
//            finishes done, ONE follow-up dry run of the plan runner is queued for the same order
//            (payload {orderId, runner:'plan', dryRun:true}, nothing is saved) and when that ends one
//            line compares the two runs.
//   plan     the real command's payload is {orderId, runner:'plan'}.
//
// Logs carry counts and fixed codes only: never links, emails, card numbers or PINs.

export type EgiftRunnerMode = 'builtin' | 'shadow' | 'plan';

let warned = false;
/** Reads EGIFT_RUNNER. Unset = shadow; an unknown value = builtin, with one warning per process. */
export function egiftRunnerMode(raw: string | undefined = process.env.EGIFT_RUNNER, warn: (m: string) => void = m => console.warn(m)): EgiftRunnerMode {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === '') return 'shadow';
  if (v === 'builtin' || v === 'shadow' || v === 'plan') return v;
  if (!warned) { warned = true; warn('[egift-runner] unknown EGIFT_RUNNER value, using builtin'); }
  return 'builtin';
}
/** Test hook: lets the one-time warning fire again. */
export function resetEgiftRunnerWarning(): void { warned = false; }

/** Payload of the REAL command for the mode. */
export function realEgiftPayload(orderId: number, mode: EgiftRunnerMode): { orderId: number; runner?: 'plan' } {
  return mode === 'plan' ? { orderId, runner: 'plan' } : { orderId };
}
export const dryRunEgiftPayload = (orderId: number) => ({ orderId, runner: 'plan', dryRun: true }) as const;

export type EgiftPayloadInfo = { orderId: number; dryRun: boolean; plan: boolean };
/** Reads a stored SCRAPE_EGIFT payload string; null when it is not one. */
export function egiftPayloadInfo(payload: string | null): EgiftPayloadInfo | null {
  let p: { orderId?: unknown; runner?: unknown; dryRun?: unknown } | null;
  try { p = JSON.parse(payload ?? 'null') as typeof p; } catch { return null; }
  if (!p || typeof p !== 'object' || typeof p.orderId !== 'number' || !Number.isInteger(p.orderId)) return null;
  const plan = p.runner === 'plan';
  return { orderId: p.orderId, plan, dryRun: plan && p.dryRun === true };
}

export type RunResult = { status: string; cards: number | null; runner: string | null; error: string | null };

const safe = (v: unknown, max: number): string | null =>
  typeof v === 'string' && v ? v.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, max) : null;

/** The count and code fields of a stored command result; never anything else. */
export function readEgiftResult(status: string, result: string | null): RunResult {
  type Raw = { cards?: unknown; runner?: unknown; error?: unknown };
  let r: Raw | null = null as Raw | null;
  try {
    let p: unknown = JSON.parse(result ?? 'null');
    if (typeof p === 'string') p = JSON.parse(p);
    if (p && typeof p === 'object') r = p as Raw;
  } catch { /* none */ }
  return {
    status,
    cards: typeof r?.cards === 'number' && Number.isFinite(r.cards) ? r.cards : null,
    runner: safe(r?.runner, 32),
    error: safe(r?.error, 48),
  };
}

export type EgiftComparison = { orderId: number; builtin: number | null; plan: number | null; match: boolean; runner: string | null; error: string | null };

export function compareEgiftRuns(orderId: number, builtin: RunResult | null, plan: RunResult): EgiftComparison {
  const b = builtin?.cards ?? null;
  const match = b !== null && plan.cards !== null && b === plan.cards && plan.status === 'done' && !plan.error;
  return { orderId, builtin: b, plan: plan.cards, match, runner: plan.runner, error: plan.error };
}

export function shadowLine(c: EgiftComparison): string {
  return `[egift-shadow] order=${c.orderId} builtin=${c.builtin ?? '?'} plan=${c.plan ?? '?'} ${c.match ? 'match' : 'MISMATCH'} plan_runner=${c.runner ?? 'unknown'}${c.error ? ` ${c.error}` : ''}`;
}

export type EndedCommand = { type: string; payload: string | null; status: string; result: string | null };

export interface ShadowDeps {
  mode: EgiftRunnerMode;
  /** True when ANY dry-run command (any state) exists for the order. */
  hasDryRun: (orderId: number) => Promise<boolean>;
  queueDryRun: (orderId: number) => Promise<void>;
  /** The most recent done real built-in command's result for the order. */
  findBuiltinResult: (orderId: number) => Promise<string | null>;
  log: (line: string) => void;
}

/**
 * Called once when a SCRAPE_EGIFT command reaches done/failed. Returns what it did, for tests.
 * Real built-in run done in shadow mode -> queue one dry run (never a second).
 * Dry run ended -> log the comparison.
 */
export async function onEgiftCommandEnded(cmd: EndedCommand, deps: ShadowDeps): Promise<'queued' | 'compared' | 'none'> {
  if (cmd.type !== 'SCRAPE_EGIFT' || (cmd.status !== 'done' && cmd.status !== 'failed')) return 'none';
  const info = egiftPayloadInfo(cmd.payload);
  if (!info) return 'none';
  if (info.dryRun) {
    const built = await deps.findBuiltinResult(info.orderId);
    deps.log(shadowLine(compareEgiftRuns(info.orderId, built ? readEgiftResult('done', built) : null, readEgiftResult(cmd.status, cmd.result))));
    return 'compared';
  }
  if (deps.mode !== 'shadow' || info.plan || cmd.status !== 'done') return 'none';
  if (await deps.hasDryRun(info.orderId)) return 'none';
  await deps.queueDryRun(info.orderId);
  return 'queued';
}
