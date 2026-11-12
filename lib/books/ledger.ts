// postEntry(): the single place a journal entry is written.
//
//  - lines must be integer cents and sum to exactly 0, or it throws
//  - a posting dated in a locked month is redated to the first day of the first
//    open month at or after it, and the memo keeps the original date
//  - append only: reverseEntry() posts the negation and sets reversedAt on the
//    original in the same transaction; nothing is updated or deleted otherwise
import type { BooksStore, EntryInput, LineInput, PostedEntry } from './types.ts';
import { DAY_RE, firstDayOf, monthOf, nextMonth } from './dates.ts';

export class UnbalancedEntryError extends Error {}
export class AlreadyReversedError extends Error {
  constructor(id: number) { super(`entry #${id} was already reversed`); }
}

export function assertBalanced(lines: { amountCents: number }[]): void {
  if (lines.length === 0) throw new UnbalancedEntryError('entry has no lines');
  let sum = 0;
  for (const l of lines) {
    if (!Number.isInteger(l.amountCents)) throw new UnbalancedEntryError(`non-integer amount ${l.amountCents}`);
    sum += l.amountCents;
  }
  if (sum !== 0) throw new UnbalancedEntryError(`entry does not balance (off by ${sum} cents)`);
}

/** Redate out of locked months. Returns the date to post on and the memo to keep. */
export function redateForLocks(date: string, memo: string, locked: Set<string>): { date: string; memo: string } {
  if (!locked.has(monthOf(date))) return { date, memo };
  let m = monthOf(date);
  let guard = 0;
  while (locked.has(m) && guard++ < 1200) m = nextMonth(m);
  return { date: firstDayOf(m), memo: `${memo} (dated ${date}, month locked)` };
}

export async function postEntry(store: BooksStore, userId: number, input: EntryInput): Promise<{ id: number; date: string }> {
  if (!DAY_RE.test(input.date)) throw new Error(`bad date ${input.date}`);
  const lines = input.lines.filter(l => l.amountCents !== 0);
  assertBalanced(lines);
  return store.transaction(async tx => {
    const locked = await tx.lockedMonths(userId);
    const { date, memo } = redateForLocks(input.date, input.memo, locked);
    const resolved = [];
    for (const l of lines) {
      const acct = await tx.resolveAccount(userId, l.account);
      resolved.push({
        accountId: acct.id,
        amountCents: l.amountCents,
        orderId: l.orderId ?? null,
        machineId: l.machineId ?? null,
        memo: l.memo ?? null,
        business: l.business ?? null,
      });
    }
    const id = await tx.insertEntry(userId, {
      date, memo, source: input.source, sourceKey: input.sourceKey,
      contentHash: input.contentHash, reversesId: input.reversesId ?? null,
    }, resolved);
    return { id, date };
  });
}

/** Post the negation of `entry` and mark it reversed, in one transaction. Reversal date = the entry's date (lock rules apply). */
export async function reverseEntry(store: BooksStore, userId: number, entry: PostedEntry, now: Date, memoSuffix = 'reversal'): Promise<number> {
  return store.transaction(async tx => {
    const lines: LineInput[] = entry.lines.map(l => ({
      account: l.accountId,
      amountCents: -l.amountCents,
      orderId: l.orderId,
      machineId: l.machineId,
      memo: l.memo,
      business: (l.business as LineInput['business']) ?? null,
    }));
    const r = await postEntry(tx, userId, {
      date: entry.date,
      memo: `Reversal of #${entry.id}: ${entry.memo} (${memoSuffix})`,
      source: 'reversal',
      sourceKey: entry.sourceKey,
      contentHash: `reversal:${entry.id}`,
      reversesId: entry.id,
      lines,
    });
    // Guarded: if another run reversed this entry first, abort the whole transaction (the reversal above rolls back).
    if (!(await tx.markReversed(entry.id, now))) throw new AlreadyReversedError(entry.id);
    return r.id;
  });
}
