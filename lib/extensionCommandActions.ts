// "Retry on sidecar" / "Cancel" rules for the Sync Status popup, kept as pure
// functions so they are testable without Prisma. The routes under
// app/api/extension/commands/[id]/{retry,cancel} apply the plan.
//
// Background: when the sidecar cannot finish a sync (bot check, signed out)
// the work is handed to a browser extension as a NEW pending command, which
// then sits "waiting for a worker" with no way back. Retry puts it back on the
// sidecar's queue without ever creating a second copy of work already pending.

export type QueueRow = {
  id: number;
  type: string;
  payload: string | null;
  status: string;
  targetBrowser: string | null;
};

/** Types the sidecar actually claims (sidecar/src/poll.js SITES). */
const SIDECAR_TYPES = new Set([
  'SYNC_AMAZON', 'SYNC_WALMART', 'SYNC_COSTCO', 'SYNC_AMAZON_ORDER',
  'SYNC_COSTCO_ORDER', 'TRACK_AMAZON', 'SCRAPE_CBM', 'SCRAPE_MGCP',
]);
const AMAZON_SIDECAR_TYPES = new Set(['SYNC_AMAZON', 'SYNC_AMAZON_ORDER']);
/** Other types the popup may retry, on whatever target they already have. */
const RETRY_ONLY_TYPES = new Set(['SYNC_AMAZON_PAGES', 'SYNC_BFMR']);

type Env = Record<string, string | undefined>;

/**
 * Does the sidecar claim this command type right now? Mirrors sidecarHandles()
 * in sidecar/src/poll.js: Amazon types need SIDECAR_AMAZON_ENABLED=1, and
 * TRACK_AMAZON is on unless SIDECAR_AMAZON_TRACKING=0.
 */
export function sidecarServes(type: string, env: Env = process.env): boolean {
  if (!SIDECAR_TYPES.has(type)) return false;
  if (type === 'TRACK_AMAZON') return env.SIDECAR_AMAZON_TRACKING !== '0';
  if (AMAZON_SIDECAR_TYPES.has(type)) return env.SIDECAR_AMAZON_ENABLED === '1';
  return true;
}

/**
 * The command type the sidecar would run for this row, or null when the type
 * is not retryable at all. SYNC_AMAZON_PAGES is the extension's passive page
 * capture; the sidecar's equivalent is its full SYNC_AMAZON.
 */
export function sidecarRetryType(type: string): string | null {
  if (type === 'SYNC_AMAZON_PAGES') return 'SYNC_AMAZON';
  return SIDECAR_TYPES.has(type) || RETRY_ONLY_TYPES.has(type) ? type : null;
}

export type RetryPlan =
  | { kind: 'unsupported' }
  | { kind: 'busy' }
  | { kind: 'already'; id: number }                              // pending copy exists on the target; just kick
  | { kind: 'retarget'; id: number; type: string; targetBrowser: string | null }
  | { kind: 'merge'; deleteId: number; keepId: number }          // drop this pending row, a copy exists on the target
  | { kind: 'create'; type: string; payload: string | null; targetBrowser: string | null };

export function planRetry(cmd: QueueRow, pending: QueueRow[], env: Env = process.env): RetryPlan {
  const sidecarType = sidecarRetryType(cmd.type);
  if (!sidecarType) return { kind: 'unsupported' };
  if (cmd.status === 'running') return { kind: 'busy' };

  // Move to the sidecar only when it really serves that type; otherwise the
  // row would sit pending forever. Then keep the original type and target.
  const toSidecar = sidecarServes(sidecarType, env);
  const type = toSidecar ? sidecarType : cmd.type;
  const target = toSidecar ? 'sidecar' : cmd.targetBrowser;

  const sameWork = (o: QueueRow) =>
    o.id !== cmd.id && o.status === 'pending' && (o.type === type || o.type === cmd.type) && (o.payload ?? null) === (cmd.payload ?? null);
  const onTarget = (o: QueueRow) => o.type === type && o.targetBrowser === target;
  const others = pending.filter(sameWork);

  if (cmd.status === 'pending') {
    if (onTarget(cmd)) return { kind: 'already', id: cmd.id };
    const copy = others.find(onTarget);
    if (copy) return { kind: 'merge', deleteId: cmd.id, keepId: copy.id };
    return { kind: 'retarget', id: cmd.id, type, targetBrowser: target };
  }

  // failed / done: queue fresh work unless a copy is already waiting.
  const copy = others.find(onTarget);
  if (copy) return { kind: 'already', id: copy.id };
  const waiting = others[0];
  if (waiting) return { kind: 'retarget', id: waiting.id, type, targetBrowser: target };
  return { kind: 'create', type, payload: cmd.payload, targetBrowser: target };
}

/** Only a row nobody has claimed can be cancelled; a running one is the worker's. */
export function canCancel(status: string): boolean {
  return status === 'pending';
}
