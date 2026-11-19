// Failure-only push for the order fill and commitment match: one note when an
// order's details could not be fetched, or when it could not be linked. A
// success never pushes. Pure and unit tested; the runner is
// lib/fillFailureRun.ts.
//
// Rules:
//   - One issue per order, told once. The issue key names the order, the kind
//     and what is missing, so the same order failing the same way never
//     repeats, but a new problem on it is new.
//   - Everything found in one run goes out as one note.
//   - The note never carries more than a handful of orders; the rest are
//     counted.
import { fillableGaps, type Gap, type GapOrder } from './gapFill.ts';

// 'none' (nothing matches) is never pushed: most orders have no reservation or
// commitment at all (personal buys), so it is not a failure. Only the cases
// where the person has to decide are: several candidates, too few units, or an
// "(xN)" name with no real quantity.
export type LinkFailure = 'several' | 'too-many' | 'qty-unknown';
export const LINK_FAILURES: readonly string[] = ['several', 'too-many', 'qty-unknown'];

export type FillFailure =
  | { kind: 'get'; orderNumber: string; missing: Gap[] }
  | { kind: 'link'; orderNumber: string; reason: LinkFailure };

const digits = (s: string | null | undefined) => (s ?? '').replace(/\D/g, '');

export function failureKey(f: FillFailure): string {
  return f.kind === 'get'
    ? `get:${digits(f.orderNumber)}:${[...f.missing].sort().join('+')}`
    : `link:${digits(f.orderNumber)}:${f.reason}`;
}

export type FinishedCommand = { status: string; orderNumbers: string[] };

/**
 * Orders a finished per-order fetch (done or failed) still could not fill.
 * Tracking is left out: it only counts once a shipping email arrived, and the
 * tracking nudge already covers that. Unfinished commands are still working.
 */
export function couldNotGet(commands: readonly FinishedCommand[], orders: readonly GapOrder[]): FillFailure[] {
  const byNumber = new Map<string, GapOrder>();
  for (const o of orders) byNumber.set(digits(o.orderNumber), o);
  const out: FillFailure[] = [];
  const seen = new Set<string>();
  for (const c of commands) {
    if (c.status !== 'done' && c.status !== 'failed') continue;
    for (const n of c.orderNumbers) {
      const key = digits(n);
      const o = byNumber.get(key);
      if (!o || seen.has(key)) continue;
      // A Walmart page that was read has no card to give when the order was paid
      // with a gift card, so a finished read never counts a missing card as a failure.
      const missing = fillableGaps({ ...o, shipped: false }).filter(g => !(g === 'card' && o.platform === 'Walmart' && c.status === 'done'));
      if (!missing.length) continue;
      seen.add(key);
      out.push({ kind: 'get', orderNumber: o.orderNumber, missing });
    }
  }
  return out;
}

const REASON: Record<LinkFailure, string> = {
  several: 'several open items match',
  'too-many': 'more units than any match has left',
  'qty-unknown': 'the name says several units and the count is unknown',
};
const MAX_LISTED = 5;

export function failureLine(f: FillFailure): string {
  return f.kind === 'get'
    ? `Order ${f.orderNumber}: could not get ${f.missing.join(', ')}`
    : `Order ${f.orderNumber}: could not link, ${REASON[f.reason]}`;
}

export type FillPush = { text: string | null; keys: string[] };

/** One note for the issues not told before, and the keys to remember. */
export function planFillPush(failures: readonly FillFailure[], alerted: ReadonlySet<string>): FillPush {
  const keys: string[] = [];
  const fresh: FillFailure[] = [];
  for (const f of failures) {
    const k = failureKey(f);
    if (alerted.has(k) || keys.includes(k)) continue;
    keys.push(k);
    fresh.push(f);
  }
  if (!fresh.length) return { text: null, keys: [] };
  const lines = fresh.slice(0, MAX_LISTED).map(failureLine);
  if (fresh.length > MAX_LISTED) lines.push(`and ${fresh.length - MAX_LISTED} more`);
  const head = fresh.length === 1 ? '1 order needs a look' : `${fresh.length} orders need a look`;
  return { text: `${head}\n${lines.join('\n')}`, keys };
}

/** The remembered keys, newest last, capped so the setting stays small. */
export function rememberKeys(prev: readonly string[], add: readonly string[], max = 400): string[] {
  return [...prev, ...add].slice(-max);
}
