// "Retry" / "Cancel" rules for the Sync Status popup, kept as pure
// functions so they are testable without Prisma. The routes under
// app/api/extension/commands/[id]/{retry,cancel} apply the plan.
//
// Retry puts a failed or stuck row back on the queue of the worker that runs
// that type, without ever creating a second copy of work already pending:
// Amazon and Costco types go to the browser extension, the other retailers to the sidecar.

import { AMAZON_COMMAND_TYPES, COSTCO_COMMAND_TYPES } from './amazonSync.ts';
import { commandTarget } from './commandWorker.ts';

export type QueueRow = {
  id: number;
  type: string;
  payload: string | null;
  status: string;
  targetBrowser: string | null;
};

/** Types the sidecar actually claims (sidecar/src/poll.js SITES). */
const SIDECAR_TYPES = new Set([
  'SYNC_WALMART', 'SYNC_WALMART_ORDER', 'SCRAPE_CBM', 'SCRAPE_MGCP',
]);
const AMAZON_TYPES: ReadonlySet<string> = new Set(AMAZON_COMMAND_TYPES);
const COSTCO_TYPES: ReadonlySet<string> = new Set(COSTCO_COMMAND_TYPES);
/** Other types the popup may retry, on whatever target they already have. */
const RETRY_ONLY_TYPES = new Set(['SYNC_BFMR', 'SCRAPE_EGIFT']);

/** Where a retry of this type runs: the browser extension for Amazon and Costco, the sidecar for its own types, else null (keep the row's target). */
export function retryTarget(type: string): string | null {
  // BFMR keeps the row's own target even though commandTarget says sidecar.
  if (type === 'SYNC_BFMR') return null;
  return commandTarget(type);
}

/**
 * The command type a retry queues for this row, or null when the type is not
 * retryable at all. The legacy full SYNC_AMAZON retries as the extension's
 * passive page capture, SYNC_AMAZON_PAGES.
 */
export function retryType(type: string): string | null {
  if (type === 'SYNC_AMAZON') return 'SYNC_AMAZON_PAGES';
  return AMAZON_TYPES.has(type) || COSTCO_TYPES.has(type) || SIDECAR_TYPES.has(type) || RETRY_ONLY_TYPES.has(type) ? type : null;
}

export type RetryPlan =
  | { kind: 'unsupported' }
  | { kind: 'busy' }
  | { kind: 'already'; id: number }                              // pending copy exists on the target; just kick
  | { kind: 'retarget'; id: number; type: string; targetBrowser: string | null }
  | { kind: 'merge'; deleteId: number; keepId: number }          // drop this pending row, a copy exists on the target
  | { kind: 'create'; type: string; payload: string | null; targetBrowser: string | null };

export function planRetry(cmd: QueueRow, pending: QueueRow[]): RetryPlan {
  const type = retryType(cmd.type);
  if (!type) return { kind: 'unsupported' };
  if (cmd.status === 'running') return { kind: 'busy' };

  // Types with no known worker keep the row's own target.
  const target = retryTarget(type) ?? cmd.targetBrowser;

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
