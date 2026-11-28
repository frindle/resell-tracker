// Split one bank row into parts (pure: no database). Each part is an amount plus one target:
//   order     a debit: that order's card charge (BankMatch order_charge); a credit: a refund of that order's return (order_refund)
//   personal  owner draw (debit) or owner contribution (credit), posted by the bank row
//   cost      a debit only: a cost entry made from this part (BankMatch cost)
// The parts must add up to the row's amount exactly. Parts with the same target merge into one.
export const MAX_SPLIT_PARTS = 20;

export type SplitPart = {
  cents: number;
  kind: 'order' | 'personal' | 'cost';
  orderId?: number; orderNumber?: string; returnId?: number;
  category?: string; business?: 'resell' | 'shared'; vendor?: string; purpose?: string; businessPct?: number;
};

export type SplitCheck = { ok: true; parts: SplitPart[] } | { ok: false; error: string };
const bad = (error: string): SplitCheck => ({ ok: false, error });

const str = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
const posInt = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined);

/** The target a part points at, as a key: parts with the same key merge. */
function targetKey(p: SplitPart): string {
  if (p.kind === 'personal') return 'personal';
  if (p.kind === 'order') return p.returnId != null ? `r#${p.returnId}` : p.orderId != null ? `#${p.orderId}` : `n:${p.orderNumber ?? ''}`;
  return `cost:${p.category}|${p.business}|${p.vendor ?? ''}|${p.purpose ?? ''}|${p.businessPct}`;
}

/**
 * Check raw input (the request body's `parts`) against the row. `totalCents` is the row's absolute amount, `credit` says it
 * is money in. Returns the cleaned parts, merged by target, or the first error.
 */
export function checkSplit(raw: unknown, totalCents: number, credit: boolean, categories: readonly string[]): SplitCheck {
  if (!Array.isArray(raw)) return bad('give the parts of the split');
  if (raw.length < 2) return bad('a split needs at least two parts');
  if (raw.length > MAX_SPLIT_PARTS) return bad(`a split has at most ${MAX_SPLIT_PARTS} parts`);
  const parts: SplitPart[] = [];
  for (const [i, r] of raw.entries()) {
    const n = i + 1;
    if (r == null || typeof r !== 'object') return bad(`part ${n} is not a part`);
    const o = r as Record<string, unknown>;
    const cents = posInt(o.cents);
    if (cents == null) return bad(`part ${n}: the amount must be a whole number of cents above 0`);
    if (o.kind === 'personal') { parts.push({ cents, kind: 'personal' }); continue; }
    if (o.kind === 'order') {
      const orderId = posInt(o.orderId), returnId = posInt(o.returnId), orderNumber = str(o.orderNumber, 100);
      if (credit ? returnId == null && orderId == null && orderNumber == null : orderId == null && orderNumber == null) return bad(`part ${n}: give an order number or #id`);
      if (!credit && returnId != null) return bad(`part ${n}: a charge pays an order, not a return`);
      parts.push({ cents, kind: 'order', ...(returnId != null ? { returnId } : orderId != null ? { orderId } : { orderNumber }) });
      continue;
    }
    if (o.kind === 'cost') {
      if (credit) return bad(`part ${n}: a cost entry comes from a debit`);
      const category = str(o.category, 60);
      if (!category || !categories.includes(category)) return bad(`part ${n}: unknown category`);
      const pct = o.businessPct === undefined ? 100 : o.businessPct;
      if (typeof pct !== 'number' || !Number.isInteger(pct) || pct < 0 || pct > 100) return bad(`part ${n}: businessPct must be 0-100`);
      parts.push({ cents, kind: 'cost', category, business: o.business === 'shared' ? 'shared' : 'resell', vendor: str(o.vendor, 120), purpose: str(o.purpose, 200), businessPct: pct });
      continue;
    }
    return bad(`part ${n}: choose an order, Personal${credit ? '' : ' or a cost entry'}`);
  }
  const sum = parts.reduce((a, p) => a + p.cents, 0);
  if (!Number.isSafeInteger(sum) || sum !== totalCents) return bad(`the parts add up to ${sum} cents but the transaction is ${totalCents}`);
  const merged = new Map<string, SplitPart>();
  for (const p of parts) {
    const k = targetKey(p), prev = merged.get(k);
    merged.set(k, prev ? { ...prev, cents: prev.cents + p.cents } : p);
  }
  return { ok: true, parts: [...merged.values()] };
}

export type SplitLink = { kind: string; refId: number; amountCents: number };

/** Merge links that name the same thing (an order given once by number and once by #id): one link per kind and refId. */
export function mergeLinks<T extends SplitLink>(links: T[]): T[] {
  const m = new Map<string, T>();
  for (const l of links) {
    const k = `${l.kind}:${l.refId}`, prev = m.get(k);
    m.set(k, prev ? { ...prev, amountCents: prev.amountCents + l.amountCents } : l);
  }
  return [...m.values()];
}
