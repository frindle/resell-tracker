import { createHash } from 'node:crypto';
import type { EntrySource, LineInput } from './types.ts';

/** What a source (order, cost entry, tally month) should currently have posted, under one sourceKey. */
export type DesiredEntry = {
  sourceKey: string;
  date: string;
  memo: string;
  source: Exclude<EntrySource, 'reversal'>;
  lines: LineInput[];
};

/** Content hash of an entry: date + every line. Same content, same hash, so nothing is re-posted. */
export function hashEntry(d: Pick<DesiredEntry, 'date' | 'lines'>): string {
  const body = JSON.stringify([
    d.date,
    d.lines.filter(l => l.amountCents !== 0).map(l => [l.account, l.amountCents, l.orderId ?? null, l.machineId ?? null, l.memo ?? null, l.business ?? null]),
  ]);
  return createHash('sha256').update(body).digest('hex');
}
