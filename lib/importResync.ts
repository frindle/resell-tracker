// Before the import matches new orders to commitments, refresh the sources the
// matcher reads (BuyingGroup commitments, BigSky commitments, BFMR
// reservations): the owner often makes the commitment just before placing the
// order, so the tracker may not hold it yet. Each source is skipped when it
// synced within RESYNC_MIN_AGE_MS (a burst of imports must not hammer the
// upstream APIs), the rest run in parallel, and each is capped at
// RESYNC_TIMEOUT_MS. A failed or slow resync is logged on one line and never
// blocks the match. COK is not a source here and is never scraped.

export type ResyncSource = 'bg' | 'bigsky' | 'bfmr';
export const RESYNC_SOURCES: readonly ResyncSource[] = ['bg', 'bigsky', 'bfmr'];
export const RESYNC_MIN_AGE_MS = 2 * 60 * 1000;
export const RESYNC_TIMEOUT_MS = 30 * 1000;

// When a resync was last tried in this process, per user and source. It also
// throttles a source whose sync fails or changes no rows (no stored timestamp moves).
const lastAttempt = new Map<string, number>();

export type ResyncDeps = {
  // Newest stored sync time (ms) for the source, or null when it holds no rows.
  lastSyncedMs: (source: ResyncSource) => Promise<number | null>;
  // Runs the shared sync; a non-ok response counts as a failure.
  run: (source: ResyncSource) => Promise<Response>;
  now?: () => number;
  attempts?: Map<string, number>;
  timeoutMs?: number;
  log?: (line: string) => void;
};

export function shouldResync(lastMs: number | null, nowMs: number, minAgeMs: number = RESYNC_MIN_AGE_MS): boolean {
  return lastMs == null || nowMs - lastMs >= minAgeMs;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: ReturnType<typeof setTimeout>;
  const timer = new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error(`timed out after ${ms}ms`)), ms); });
  return Promise.race([p, timer]).finally(() => clearTimeout(t));
}

// Never throws. Returns what each source did.
export async function resyncBeforeMatch(
  userId: number,
  deps: ResyncDeps,
  sources: readonly ResyncSource[] = RESYNC_SOURCES,
): Promise<Record<ResyncSource, 'synced' | 'skipped' | 'failed' | 'off'>> {
  const now = deps.now ?? Date.now;
  const attempts = deps.attempts ?? lastAttempt;
  const timeoutMs = deps.timeoutMs ?? RESYNC_TIMEOUT_MS;
  const log = deps.log ?? ((l: string) => console.log(l));
  const out: Record<ResyncSource, 'synced' | 'skipped' | 'failed' | 'off'> = { bg: 'off', bigsky: 'off', bfmr: 'off' };
  await Promise.all(sources.map(async source => {
    try {
      const key = `${userId}:${source}`;
      const tried = attempts.get(key) ?? null;
      const stored = await withTimeout(deps.lastSyncedMs(source), timeoutMs);
      const last = tried == null ? stored : stored == null ? tried : Math.max(tried, stored);
      if (!shouldResync(last, now())) { out[source] = 'skipped'; return; }
      attempts.set(key, now());
      const res = await withTimeout(deps.run(source), timeoutMs);
      if (res.status === 400) { out[source] = 'off'; return; } // source not connected: nothing to refresh
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      out[source] = 'synced';
    } catch (e) {
      out[source] = 'failed';
      log(`[import] ${source} resync before match failed, matching anyway: ${String(e).slice(0, 160)}`);
    }
  }));
  return out;
}
