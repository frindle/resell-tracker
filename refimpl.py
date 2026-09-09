#!/usr/bin/env python3
"""Reference impl for bfmr-link-guard. Injects the pure guardLink/normTracking
helper into lib/bfmrAutoLink.ts and wires it into the auto-link create site and
the manual links POST route. Edits TRACKED files only (git checkout reverts)."""
import sys, pathlib

root = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ".")

# ---- 1. helper + wiring in lib/bfmrAutoLink.ts ----
al = root / "lib" / "bfmrAutoLink.ts"
s = al.read_text()

HELPER = '''
export function normTracking(s: string | null | undefined): string {
  return (s ?? '').replace(/\\s+/g, '').toUpperCase();
}

export type GuardExistingLink = { id: number; reservationId: number; quantity: number; trackingNumber: string | null };
export type GuardProposal = {
  orderId: number;
  reservationId: number;
  quantity: number;
  trackingNumber: string | null;
  reservationQty: number;
  excludeLinkId?: number;
};

// Pure invariant guard for OrderBfmrLink writes. Rejects (a) a second link with
// the same normalized tracking on one order, and (b) a change that pushes a
// reservation's summed link.quantity over reservation.qty. No DB access.
export function guardLink(
  orderLinks: GuardExistingLink[],
  p: GuardProposal,
): { ok: true } | { ok: false; reason: string } {
  const t = normTracking(p.trackingNumber);
  if (t) {
    for (const l of orderLinks) {
      if (l.id === p.excludeLinkId) continue;
      if (normTracking(l.trackingNumber) === t) {
        return { ok: false, reason: `duplicate tracking ${t} already on order ${p.orderId} (link ${l.id})` };
      }
    }
  }
  let sum = p.quantity;
  for (const l of orderLinks) {
    if (l.id === p.excludeLinkId) continue;
    if (l.reservationId === p.reservationId) sum += l.quantity;
  }
  if (sum > p.reservationQty) {
    return { ok: false, reason: `reservation ${p.reservationId} over-allocated: ${sum} > ${p.reservationQty}` };
  }
  return { ok: true };
}
'''

anchor = "function normDigits(s: string | null | undefined): string {\n  return (s ?? '').replace(/\\D/g, '');\n}\n"
assert anchor in s, "normDigits anchor not found in bfmrAutoLink.ts"
s = s.replace(anchor, anchor + HELPER, 1)

# wire the auto-link create site
create_anchor = (
    "    if (!orderId) continue;\n"
    "    try {\n"
    "      await prisma.orderBfmrLink.create({"
)
create_wired = (
    "    if (!orderId) continue;\n"
    "    const existingLinks = await prisma.orderBfmrLink.findMany({ where: { orderId }, select: { id: true, reservationId: true, quantity: true, trackingNumber: true } });\n"
    "    const guard = guardLink(existingLinks, { orderId, reservationId: r.id, quantity: r.qty, trackingNumber: r.trackingNumber, reservationQty: r.qty });\n"
    "    if (!guard.ok) { console.warn(`[bfmr/auto-link] guard blocked reservation ${r.id} → order ${orderId}: ${guard.reason}`); continue; }\n"
    "    try {\n"
    "      await prisma.orderBfmrLink.create({"
)
assert create_anchor in s, "auto-link create anchor not found"
s = s.replace(create_anchor, create_wired, 1)
al.write_text(s)

# ---- 2. wire the manual links POST route ----
rt = root / "app" / "api" / "bfmr" / "links" / "route.ts"
r = rt.read_text()

imp = "import { recalcBfmrSalePrice } from '@/lib/bfmrSalePrice';"
assert imp in r, "recalcBfmrSalePrice import not found in route.ts"
r = r.replace(imp, imp + "\nimport { guardLink } from '@/lib/bfmrAutoLink';", 1)

guard_anchor = "  try {\n    const existing = await prisma.orderBfmrLink.findFirst({"
guard_wired = (
    "  const orderLinks = await prisma.orderBfmrLink.findMany({ where: { orderId: body.orderId }, select: { id: true, reservationId: true, quantity: true, trackingNumber: true } });\n"
    "  const dupTarget = orderLinks.find(l => l.reservationId === body.reservationId && l.trackingNumber === trackingNumber);\n"
    "  const guard = guardLink(orderLinks, { orderId: body.orderId, reservationId: body.reservationId, quantity, trackingNumber, reservationQty: reservation.qty, excludeLinkId: dupTarget?.id });\n"
    "  if (!guard.ok) return Response.json({ error: guard.reason }, { status: 409 });\n\n"
    "  try {\n    const existing = await prisma.orderBfmrLink.findFirst({"
)
assert guard_anchor in r, "route.ts try/existing anchor not found"
r = r.replace(guard_anchor, guard_wired, 1)
rt.write_text(r)

print("refimpl applied: helper+wiring in bfmrAutoLink.ts, wiring+import in route.ts")
