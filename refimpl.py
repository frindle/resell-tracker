#!/usr/bin/env python3
"""Reference impl for: bfmr-relink-v3

Inserts the `relinkStaleBfmrLinks` reconciliation pass into lib/bfmrAutoLink.ts
and wires it into autoLinkBfmrReservations (right after capOverallocatedBfmrLinks,
so it runs on every sync/import). This is the coordinator's verified reference;
the gate applies it, runs verify, reverts it, then the dispatched model re-derives.
"""
import pathlib
import sys

wt = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ".")
p = wt / 'lib/bfmrAutoLink.ts'
t = p.read_text()

FUNC = r'''export async function relinkStaleBfmrLinks(
  userId: number | null,
  orderIds?: number[],
): Promise<number> {
  const links = await prisma.orderBfmrLink.findMany({
    where: { ...(orderIds ? { orderId: { in: orderIds } } : {}), reservation: { userId } },
    select: {
      id: true, orderId: true, reservationId: true, quantity: true, value: true, trackingNumber: true,
      reservation: { select: { id: true, bfmrOrderId: true, qty: true } },
    },
  });

  const orders = await prisma.order.findMany({
    where: { userId, ...(orderIds ? { id: { in: orderIds } } : {}) },
    select: { id: true, orderNumber: true },
  });
  if (links.length === 0 || orders.length === 0) return 0;

  // Same normalization/containment rule as matchByOrderNumber above.
  const matches = (oNorm: string, rNorm: string): boolean => {
    if (!oNorm || !rNorm) return false;
    if (oNorm === rNorm) return true;
    const shorter = oNorm.length < rNorm.length ? oNorm : rNorm;
    const longer = oNorm.length < rNorm.length ? rNorm : oNorm;
    return shorter.length >= 7 && longer.includes(shorter);
  };

  let relinked = 0;
  const touchedOrderIds = new Set<number>();
  for (const l of links) {
    try {
      if (!l.reservation.bfmrOrderId) continue; // null: nothing to reconcile against
      const rNorm = normDigits(l.reservation.bfmrOrderId);
      if (!rNorm) continue;

      const current = orders.find(o => o.id === l.orderId);
      if (current && matches(normDigits(current.orderNumber), rNorm)) continue; // already correct — never stomp

      const candidates = orders.filter(o => o.id !== l.orderId && normDigits(o.orderNumber) === rNorm);
      if (candidates.length !== 1) {
        console.warn(`[bfmr/auto-link] relink skipped for reservation ${l.reservationId} (link ${l.id}, bfmrOrderId ${l.reservation.bfmrOrderId}): ${candidates.length} order(s) match by exact digits — ambiguous`);
        continue;
      }
      const target = candidates[0];

      const targetLinks = await prisma.orderBfmrLink.findMany({
        where: { orderId: target.id },
        select: { id: true, reservationId: true, quantity: true, trackingNumber: true },
      });
      if (targetLinks.some(t => t.reservationId === l.reservationId)) {
        console.warn(`[bfmr/auto-link] relink skipped for reservation ${l.reservationId} → order ${target.id}: already linked there`);
        continue;
      }
      const guard = guardLink(targetLinks, {
        orderId: target.id,
        reservationId: l.reservationId,
        quantity: l.quantity,
        trackingNumber: l.trackingNumber,
        reservationQty: l.reservation.qty,
      });
      if (!guard.ok) {
        console.warn(`[bfmr/auto-link] relink skipped for reservation ${l.reservationId} → order ${target.id}: ${guard.reason}`);
        continue;
      }

      await prisma.orderBfmrLink.update({ where: { id: l.id }, data: { orderId: target.id } });
      touchedOrderIds.add(l.orderId);
      touchedOrderIds.add(target.id);
      relinked++;
      console.log(`[bfmr/auto-link] re-pointed link ${l.id} (reservation ${l.reservationId}): order ${l.orderId} → order ${target.id}`);
    } catch (e) {
      console.warn(`[bfmr/auto-link] relink failed for link ${l.id}:`, e);
    }
  }

  for (const oid of touchedOrderIds) {
    await recalcBfmrSalePrice(oid);
  }
  return relinked;
}

'''

# 1. Insert the function immediately before autoLinkBfmrReservations' doc comment.
ANCHOR_FN = "// Auto-link unlinked BFMR reservations to local orders. Two match signals,"
assert ANCHOR_FN in t, "refimpl anchor (autoLink doc comment) not found -- did the target change?"
t = t.replace(ANCHOR_FN, FUNC + ANCHOR_FN, 1)

# 2. Wire the call in, right after the capOverallocatedBfmrLinks call.
ANCHOR_CALL = "  await capOverallocatedBfmrLinks(userId);"
assert ANCHOR_CALL in t, "refimpl anchor (capOverallocated call) not found -- did the target change?"
t = t.replace(
    ANCHOR_CALL,
    ANCHOR_CALL + "\n  await relinkStaleBfmrLinks(userId, orderIds);",
    1,
)

p.write_text(t)
print("refimpl applied: relinkStaleBfmrLinks inserted + wired into autoLinkBfmrReservations")
