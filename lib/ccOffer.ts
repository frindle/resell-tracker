// Card Center's ParsedCards response lists an offer for every open reservation that fits the cards'
// brand and value, whichever reservation the URL named. Submitting offers[0] can therefore fill a
// different reservation than the one picked (2026-11-26: two PlayStation $25 reservations, the first
// batch filled #753927 while the tracker recorded #753953, so the second batch 404'd on #753927).

type Offer = { reservation?: Record<string, unknown> | null };

const idOf = (o: Offer | undefined) => Number(o?.reservation?.id);

/** The offer for the reservation the user picked; offers[0] only when CC did not list that one. */
export function offerFor<T extends Offer>(offers: readonly T[] | null | undefined, reservationId: number): T | undefined {
  if (!offers?.length) return undefined;
  return offers.find(o => idOf(o) === reservationId) ?? offers[0];
}

/** The reservation a submission went to, for the cards' ccReservationId; the picked one when CC gave no id. */
export function offerReservationId(offer: Offer | undefined, picked: number): number {
  const id = idOf(offer);
  return Number.isInteger(id) && id > 0 ? id : picked;
}
