import { couldNotGet, planFillPush, rememberKeys, LINK_FAILURES, type FillFailure, type LinkFailure } from './fillFailureAlert.ts';
import type { GapOrder } from './gapFill.ts';

// The failure-push logic of lib/fillFailureRun.ts with its database and
// Pushover access injected, so it can be tested without either.

export type FillStore = {
  getTold(userId: number): Promise<string[]>;
  saveTold(userId: number, keys: string[]): Promise<void>;
  /** The user's Pushover credentials, or null when not set up. */
  getPushover(userId: number): Promise<{ key: string; token: string } | null>;
  send(creds: { key: string; token: string }, text: string): Promise<void>;
};

// One push at a time per user: the told list is read, the note sent, and the
// list saved as a unit, so two overlapping runs (a sidecar import and the email
// cycle) cannot both tell the same issue. In-process: the app is one server.
const chains = new Map<number, Promise<unknown>>();
function exclusive<T>(userId: number, fn: () => Promise<T>): Promise<T> {
  const run = (chains.get(userId) ?? Promise.resolve()).then(fn, fn);
  const tail = run.catch(() => {});
  chains.set(userId, tail);
  void tail.then(() => { if (chains.get(userId) === tail) chains.delete(userId); });
  return run;
}

/**
 * Sends one note for the issues not told before. The issues are remembered only
 * after the note went out (or when Pushover is not set up, so they do not flood
 * in the day it is); a failed send leaves them to be told on the next run.
 */
export function pushFailures(store: FillStore, userId: number, failures: FillFailure[]): Promise<number> {
  if (!failures.length) return Promise.resolve(0);
  return exclusive(userId, async () => {
    const before = await store.getTold(userId);
    const plan = planFillPush(failures, new Set(before));
    if (!plan.text) return 0;
    const creds = await store.getPushover(userId);
    if (creds) {
      try {
        await store.send(creds, plan.text);
      } catch (e) {
        console.error('[fill-failure] pushover failed:', String(e).slice(0, 160));
        return 0;
      }
    }
    await store.saveTold(userId, rememberKeys(before, plan.keys));
    return creds ? plan.keys.length : 0;
  });
}

export type FinishedRow = { status: string; orderNumbers: string[]; userId: number | null };
export type OrderRow = GapOrder & { userId: number | null };

/**
 * Per-user failures from finished per-order commands. A command counts only for
 * the user named in its payload (older commands without one are skipped), and
 * only for that user's own unlocked orders.
 */
export function failuresByUser(finished: readonly FinishedRow[], rows: readonly OrderRow[]): Map<number, FillFailure[]> {
  const out = new Map<number, FillFailure[]>();
  const users = new Set(finished.map(c => c.userId).filter((u): u is number => u != null));
  for (const uid of users) {
    const mine = finished.filter(c => c.userId === uid && c.orderNumbers.length).map(c => ({ status: c.status, orderNumbers: c.orderNumbers }));
    const orders = rows.filter(r => r.userId === uid);
    const f = couldNotGet(mine, orders);
    if (f.length) out.set(uid, f);
  }
  return out;
}

export type UnplacedLike = { orderId: number; reason: string };

/** The unplaced orders worth a note, with their order numbers. */
export function linkFailures(unplaced: readonly UnplacedLike[], numberOf: ReadonlyMap<number, string | null>): FillFailure[] {
  return unplaced.flatMap(u => {
    const orderNumber = numberOf.get(u.orderId);
    return orderNumber && LINK_FAILURES.includes(u.reason) ? [{ kind: 'link' as const, orderNumber, reason: u.reason as LinkFailure }] : [];
  });
}
