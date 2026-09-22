// Cross-order link exclusion for BFMR pricing. Pure (no prisma): given the set
// of OrderBfmrLink rows recalcBfmrSalePrice is about to sum, drop the ones whose
// RESERVATION names a different retailer order than the order being priced.
//
// guardLink (lib/bfmrLinkGuard.ts) stops this pair from being created going
// forward, but links made before that guard existed are still in the database
// and still get summed. The live case is link 127: order 219 (AirPods Pro 3,
// 112-2600594-9517060) holds reservation 103 — an Apple Watch reservation whose
// own bfmrOrderId is 112-8973564-0951402, an order that isn't even in this
// database — because Amazon consolidated both boxes under one tracking number
// (TBA327676654858) and the old tracking-only fallback linked them. Both
// reservations endorse that tracking, so selectCanonicalBfmrLinks correctly
// keeps both, and the next recalc would push order 219 from $597 to $1584.
//
// The comparison is NOT reimplemented here: it is guardLink's third invariant,
// reservationContradictsOrder — digits-only, bidirectional, 7-digit floor, and
// UNKNOWN (absent or too-short on EITHER side) is never a contradiction. That
// last part is load-bearing: 7 of the 132 live links have no captured
// reservation order number and are correct, wanted links, so this must never
// become "drop anything without a captured order number".
//
// This EXCLUDES the contradicted link from the price; it does not delete it.
// The row stays for the record and the linker still shows it with an X to
// unlink by hand.

// Extension-bearing specifier so this module also loads under Node's test
// runner with type stripping, same as lib/bfmrAutoLink.ts.
import { reservationContradictsOrder } from './bfmrLinkGuard.ts';

export interface CrossOrderLinkLike {
  id: number;
  reservationId: number;
  /**
   * The RESERVATION row's own bfmrOrderId, as BFMR reported it. Optional:
   * undefined/null means BFMR captured no order number for that reservation,
   * which is UNKNOWN — not a contradiction.
   */
  reservationBfmrOrderId?: string | null;
}

export function dropContradictedLinks<T extends CrossOrderLinkLike>(
  links: T[],
  orderNumber: string | null | undefined,
  /** Optional sink for the drops, so the caller can log what it excluded. */
  onDrop?: (link: T) => void,
): T[] {
  return links.filter((l) => {
    if (!reservationContradictsOrder(l.reservationBfmrOrderId, orderNumber)) return true;
    onDrop?.(l);
    return false;
  });
}
