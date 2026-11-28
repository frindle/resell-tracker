// Which order an incoming row lands on when one order number is on several
// orders (a cancelled one and a live one). Pure, no I/O.

type Pickable = { id: number; orderNumber: string | null; cancelled: boolean | null };

const digitsOnly = (n: string | null | undefined) => String(n ?? '').replace(/\D/g, '');

/** True when `a` should be taken over `b`: a live order beats a cancelled one, then the newer (higher id). */
export function betterOrder(a: Pick<Pickable, 'id' | 'cancelled'>, b: Pick<Pickable, 'id' | 'cancelled'>): boolean {
  const aLive = a.cancelled !== true;
  const bLive = b.cancelled !== true;
  if (aLive !== bLive) return aLive;
  return a.id > b.id;
}

/** One order per order number (digits only), by the rule above. Orders with no number are left out. */
export function pickByOrderNumber<T extends Pickable>(rows: readonly T[]): Map<string, T> {
  const out = new Map<string, T>();
  for (const o of rows) {
    const d = digitsOnly(o.orderNumber);
    if (!d) continue;
    const cur = out.get(d);
    if (!cur || betterOrder(o, cur)) out.set(d, o);
  }
  return out;
}
