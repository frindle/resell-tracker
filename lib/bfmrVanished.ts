// A reservation the open-status pull no longer returns has either moved to a finished
// status (paid, cancelled, ...) or vanished. Instead of pulling every finished status
// on every sync, look each one up by its retailer order number (BFMR `search`).

export type LocalOpenRow = { lineKey: string | null; bfmrOrderId: string | null; status: string };

const FINISHED = new Set(['paid', 'cancelled', 'returned', 'return', 'set_aside', 'closed']);

/** Distinct order numbers of local open rows whose line is absent from the pull. Capped. */
export function vanishedOrderIds(local: LocalOpenRow[], seenKeys: Set<string>, cap = 5): string[] {
  const out: string[] = [];
  for (const r of local) {
    if (FINISHED.has(String(r.status).toLowerCase())) continue;
    if (!r.bfmrOrderId || !r.lineKey || seenKeys.has(r.lineKey)) continue;
    if (!out.includes(r.bfmrOrderId)) out.push(r.bfmrOrderId);
    if (out.length >= cap) break;
  }
  return out;
}

/** Keep only search hits for exactly this order (an ignored `search` must not leak rows). */
export function itemsForOrder(items: Record<string, unknown>[], orderId: string): Record<string, unknown>[] {
  return items.filter(i => String(i.order_id ?? '') === orderId);
}
