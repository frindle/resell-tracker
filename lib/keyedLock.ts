// One piece of work at a time per key, in the order it was asked for. Used
// where a change is "load a row, modify it, save it" and two changes at once
// would overwrite each other. Process-wide (the map lives on globalThis so
// every copy of this module shares it).
const g = globalThis as unknown as { __keyedLocks?: Map<string, Promise<unknown>> };
const tails: Map<string, Promise<unknown>> = (g.__keyedLocks ??= new Map());

export function withKeyedLock<T>(key: string, work: () => Promise<T>): Promise<T> {
  const before = tails.get(key) ?? Promise.resolve();
  const run = before.then(work, work);
  const tail = run.then(() => undefined, () => undefined);
  tails.set(key, tail);
  void tail.then(() => { if (tails.get(key) === tail) tails.delete(key); });
  return run;
}
