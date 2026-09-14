/**
 * Server-side decision gate for BFMR -> Amazon auto-buy.
 *
 * The feature spends real money, so every condition that must hold is enforced
 * here, all at once, in one pure function -- no I/O, no database, no partial
 * approvals. A caller may only place an order when `approved` is true; the
 * `reasons` array explains exactly which gate(s) failed and is empty on a pass.
 */

export interface AutoBuyReservation {
  id: number;
  /** Units the reservation requires (BfmrReservation.qty). */
  requiredQty: number;
  /** Sum of OrderBfmrLink.quantity already linked to this reservation. */
  orderedQty: number;
  /** Per-reservation price ceiling, or null when none was set. */
  maxPrice: number | null;
}

export interface AutoBuyGroup {
  cardId: number | null;
  savedAddressId: number | null;
  autoBuyEnabled: boolean;
}

export interface AutoBuyOffer {
  soldAndShippedByAmazon: boolean;
  price: number | null;
}

export interface AutoBuyContext {
  killSwitch: boolean;
  confirmationToken: string | null;
}

export interface AutoBuyDecision {
  approved: boolean;
  reasons: string[];
  cardId: number | null;
  savedAddressId: number | null;
  qty: number;
}

/**
 * Evaluate whether an auto-buy order may be placed for `reservation` against
 * `offer`. Pure: same inputs, same decision.
 */
export function evaluateAutoBuy(
  reservation: AutoBuyReservation,
  group: AutoBuyGroup,
  offer: AutoBuyOffer,
  ctx: AutoBuyContext,
): AutoBuyDecision {
  const reasons: string[] = [];

  // PRIMARY GATE, checked first: the double-order guard. A reservation that is
  // already filled (orderedQty >= requiredQty) must never be re-ordered, no
  // matter how good everything else looks.
  const remaining = reservation.requiredQty - reservation.orderedQty;
  if (remaining <= 0) {
    reasons.push('reservation is already filled: no remaining quantity to order');
  }

  if (ctx.killSwitch) {
    reasons.push('global kill switch is engaged');
  }

  if (!offer.soldAndShippedByAmazon) {
    reasons.push('offer is not sold and shipped by Amazon.com');
  }

  if (offer.price == null) {
    reasons.push('offer has no price');
  } else if (reservation.maxPrice == null) {
    reasons.push('no per-reservation price ceiling set; refusing to buy without one');
  } else if (offer.price > reservation.maxPrice) {
    reasons.push(`offer price ${offer.price} exceeds the reservation's max price ceiling of ${reservation.maxPrice}`);
  }

  if (group.cardId == null) {
    reasons.push('no designated card on the group');
  }

  if (group.savedAddressId == null) {
    reasons.push('no designated saved address on the group');
  }

  // Authorization gate: an explicit per-order confirmation token OR the group's
  // auto-buy opt-in. Neither present -> no order.
  const authorized = Boolean(ctx.confirmationToken) || group.autoBuyEnabled;
  if (!authorized) {
    reasons.push('not authorized: no confirmation token and group auto-buy opt-in is off');
  }

  const approved = reasons.length === 0;
  return {
    approved,
    reasons,
    cardId: group.cardId,
    savedAddressId: group.savedAddressId,
    qty: approved ? remaining : 0,
  };
}
