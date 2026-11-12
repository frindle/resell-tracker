// One reconcile at a time per user. The map lives on globalThis (under a keyed symbol) so every bundled copy of this
// module (the Next server bundle and the instrumentation bundle are built separately) shares the same lock.
const KEY = Symbol.for('resell-tracker.books.exclusive');
type Slot = Map<number, Promise<unknown>>;

function slot(): Slot {
  const g = globalThis as unknown as Record<symbol, Slot | undefined>;
  return (g[KEY] ??= new Map());
}

export function exclusive<T>(userId: number, fn: () => Promise<T>): Promise<T> {
  const running = slot();
  const prev = running.get(userId) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  running.set(userId, next);
  next.finally(() => { if (running.get(userId) === next) running.delete(userId); }).catch(() => undefined);
  return next;
}
