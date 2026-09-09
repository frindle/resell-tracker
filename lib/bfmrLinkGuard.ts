// Pure invariant guard for OrderBfmrLink writes (no DB, no I/O — loads under
// `node --experimental-strip-types`). Two invariants, both of which the 907
// incident violated: a single order must never carry two links with the same
// tracking number, and the summed link.quantity against one reservation must
// never exceed that reservation's qty. Call guardLink BEFORE every create or
// update of an OrderBfmrLink; on { ok: false } skip (auto-link) or 409 (API).

export function normTracking(s: string | null | undefined): string {
  return (s ?? '').replace(/\s/g, '').toUpperCase();
}

export type GuardOrderLink = {
  id: number;
  reservationId: number;
  quantity: number;
  trackingNumber: string | null;
};

export type GuardParams = {
  orderId: number;
  reservationId: number;
  quantity: number;
  trackingNumber: string | null;
  /** The reservation's own qty — the budget this link draws against. */
  reservationQty: number;
  /** In-place update: skip comparing/summing this link against itself. */
  excludeLinkId?: number;
};

export function guardLink(
  orderLinks: GuardOrderLink[],
  p: GuardParams,
): { ok: true } | { ok: false; reason: string } {
  const t = normTracking(p.trackingNumber);
  if (t !== '') {
    for (const l of orderLinks) {
      if (l.id === p.excludeLinkId) continue;
      if (normTracking(l.trackingNumber) === t) {
        return {
          ok: false,
          reason: `duplicate tracking ${t} already on order ${p.orderId} (link ${l.id})`,
        };
      }
    }
  }

  const existingQty = orderLinks.reduce(
    (sum, l) =>
      l.reservationId === p.reservationId && l.id !== p.excludeLinkId
        ? sum + l.quantity
        : sum,
    0,
  );
  if (existingQty + p.quantity > p.reservationQty) {
    return {
      ok: false,
      reason: `over-allocated: reservation ${p.reservationId} already has ${existingQty} linked units; adding ${p.quantity} exceeds its qty of ${p.reservationQty}`,
    };
  }

  return { ok: true };
}
