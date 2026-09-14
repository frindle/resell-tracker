#!/usr/bin/env python3
"""Reference impl for rt-autobuy-decision. Overwrites the tracked stub; revert restores it."""
import pathlib, sys
wt = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ".")
p = wt / 'lib/autoBuyDecision.ts'

IMPL = r'''// Pure, server-side decision gate for BFMR -> Amazon auto-buy.
// This feature spends real money, so EVERY guard lives here, decided all at
// once, and the caller must obey `approved`. No I/O, no imports beyond types.

export interface AutoBuyReservation {
  id: number;
  requiredQty: number;   // BfmrReservation.qty
  orderedQty: number;    // sum of OrderBfmrLink.quantity already linked to this reservation
  maxPrice: number | null; // per-reservation price ceiling
}
export interface AutoBuyGroupConfig {
  cardId: number | null;         // designated payment card for the group
  savedAddressId: number | null; // designated saved shipping address for the group
  autoBuyEnabled: boolean;       // per-group opt-in to unattended auto-buy
}
export interface AutoBuyOffer {
  soldAndShippedByAmazon: boolean;
  price: number | null;
}
export interface AutoBuyContext {
  killSwitch: boolean;               // global kill switch: true => never approve
  confirmationToken: string | null;  // explicit per-order human confirmation
}
export interface AutoBuyDecision {
  approved: boolean;
  reasons: string[];
  cardId: number | null;
  savedAddressId: number | null;
  qty: number;
}

export function evaluateAutoBuy(
  reservation: AutoBuyReservation,
  group: AutoBuyGroupConfig,
  offer: AutoBuyOffer,
  ctx: AutoBuyContext,
): AutoBuyDecision {
  const reasons: string[] = [];

  // PRIMARY GATE (first): only an UNFILLED reservation may buy.
  const remaining = reservation.requiredQty - reservation.orderedQty;
  if (remaining <= 0) reasons.push('reservation already filled: no remaining quantity needed');

  // Global kill switch.
  if (ctx.killSwitch) reasons.push('kill switch engaged');

  // Constraint 1: sold AND shipped by Amazon.com.
  if (!offer.soldAndShippedByAmazon) reasons.push('offer is not sold and shipped by Amazon.com');

  // Constraint 2: price present, ceiling set, and at or below ceiling.
  if (offer.price == null) reasons.push('offer price unavailable');
  if (reservation.maxPrice == null) reasons.push('no price ceiling set for reservation');
  if (offer.price != null && reservation.maxPrice != null && offer.price > reservation.maxPrice) {
    reasons.push(`price ${offer.price} exceeds ceiling ${reservation.maxPrice}`);
  }

  // Constraint 3 & 4: designated card and saved address.
  if (group.cardId == null) reasons.push('no designated payment card for group');
  if (group.savedAddressId == null) reasons.push('no designated saved address for group');

  // Authorization: explicit per-order confirmation OR the group opted in.
  if (!ctx.confirmationToken && !group.autoBuyEnabled) {
    reasons.push('requires explicit confirmation token or group auto-buy opt-in');
  }

  const approved = reasons.length === 0;
  return {
    approved,
    reasons,
    cardId: group.cardId,
    savedAddressId: group.savedAddressId,
    qty: approved ? Math.max(0, remaining) : 0,
  };
}
'''
p.write_text(IMPL)
assert 'evaluateAutoBuy' in IMPL and 'soldAndShippedByAmazon' in IMPL and 'killSwitch' in IMPL and 'orderedQty' in IMPL
print("refimpl applied")
