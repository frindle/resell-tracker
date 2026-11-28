// Decides what a group's payment email can be tied to. Pure: the DB lookups and writes are in groupRemittance.ts.
import { normTracking } from './bgReceiptEmail.ts';
import type { RemittanceLine } from './remittanceParse.ts';

export type RemittanceOrder = { id: number; trackingNumbers: string | null; buyerId: number | null };

/** normalized tracking number -> the ids of the orders carrying it (case-insensitive, comma-separated lists split). */
export function trackingIndex(orders: readonly RemittanceOrder[]): Map<string, number[]> {
  const idx = new Map<string, number[]>();
  for (const o of orders) {
    for (const part of String(o.trackingNumbers ?? '').split(',')) {
      const t = normTracking(part);
      if (!t) continue;
      const ids = idx.get(t) ?? [];
      if (!ids.includes(o.id)) ids.push(o.id);
      idx.set(t, ids);
    }
  }
  return idx;
}

export type RemittancePlan = {
  /** Every line named exactly one order and the lines add up to the total: per-order cents can be stored. */
  exact: boolean;
  amounts: Map<number, number>;
  /** Lines whose tracking number matches no order, or more than one (not guessed). */
  unresolved: number;
  /** Lines resolved to an order. */
  resolved: number;
  /** The orders the resolved lines belong to. */
  orderIds: number[];
};

export function planRemittance(totalCents: number, lines: readonly RemittanceLine[], index: ReadonlyMap<string, number[]>): RemittancePlan {
  const amounts = new Map<number, number>();
  let unresolved = 0, resolved = 0, sum = 0;
  for (const l of lines) {
    sum += l.amountCents;
    const ids = index.get(normTracking(l.tracking));
    if (!ids || ids.length !== 1) { unresolved++; continue; }
    resolved++;
    amounts.set(ids[0], (amounts.get(ids[0]) ?? 0) + l.amountCents);
  }
  const exact = lines.length > 0 && unresolved === 0 && sum === totalCents && [...amounts.values()].every(c => c > 0);
  return { exact, amounts, unresolved, resolved, orderIds: [...amounts.keys()] };
}

/** Which of the users owns a payment email: the one most of its lines resolve for (a tie, or none resolving, is nobody's). */
export function pickOwner(resolvedByUser: ReadonlyMap<number, number>): number | null {
  const ranked = [...resolvedByUser].filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  if (!ranked.length) return null;
  return ranked.length > 1 && ranked[0][1] === ranked[1][1] ? null : ranked[0][0];
}

/** A ref for a payment email that names no payment id: its day, total and a short hash of its tracking numbers (stable per email). */
export function fallbackRef(day: string, totalCents: number, lines: readonly RemittanceLine[]): string {
  let h = 5381;
  for (const c of lines.map(l => normTracking(l.tracking)).sort().join(',')) h = ((h * 33) ^ c.charCodeAt(0)) >>> 0;
  return `email-${day}-${totalCents}-${h.toString(36)}`;
}
