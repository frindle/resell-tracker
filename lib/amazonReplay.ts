// Replay: re-parse stored pages with the CURRENT parser and diff the result
// against the orders' current stored values. Pure; scripts/amazon-replay.ts
// does the loading. Reuses the backtest field checks so live and replay agree.
import type { ParsedPage } from './amazonPageParse.ts';
import { compareOrder, type ExistingOrder, type CompareContext } from './amazonCompare.ts';
import { checkOrderFields, observationsOf, tally, type Observation, type OrderCheck, type Report } from './amazonBacktest.ts';

const digits = (s: string) => s.replace(/\D/g, '');

export function replayPage(at: Date, parsed: ParsedPage, existing: Map<string, ExistingOrder>, ctx: CompareContext): Observation[] {
  if (parsed.blocked || parsed.parseFailed) return [];
  const checks: OrderCheck[] = [];
  for (const o of parsed.orders) {
    const ex = existing.get(digits(o.orderNumber)) ?? null;
    const c = checkOrderFields(o, ex, ctx, ex ? compareOrder(o, ex, ctx) : undefined);
    if (c) checks.push(c);
  }
  return observationsOf(at, checks);
}

/** Latest page wins per (order, field); stored values are current, so nothing is excluded as "filled by the page". */
export function replayReport(obs: Observation[]): Report {
  return tally(obs, { excludeEverFilled: false });
}
