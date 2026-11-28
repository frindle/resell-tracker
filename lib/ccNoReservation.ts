// UNCONFIRMED and NOT WIRED IN. Do not call from a route until a network
// capture of CardCenter's own site confirms the request shape.
//
// What is known: POST /Api/Submissions rejects a body without a reservation or
// submitted cards with "Submissions must have at least one new reservation or
// at least one submitted card" (docs/CardCenter api.md), which suggests a group
// may carry a NEW reservation request instead of an existing reservation. GET
// /Api/Rates/{id} is documented as holding "everything needed to submit a card
// without a separate agreement fetch". The seller-side JavaScript that builds
// the request is not in CardCenter's public bundles (it loads after login), so
// the exact body below is a guess from those two hints.
//
// A capture must show, while submitting cards on CardCenter's site WITHOUT
// first reserving: the request URL(s) and method (a ParsedCards-style call
// without a reservation id, then POST /Api/Submissions?), the full JSON body of
// each (what a group holds instead of `reservation`: a `buyOrder`/`rate` id? an
// `offers` entry? a `quantity` reservation request?), and the response shape.
import { ccApiFetch, ccJson, type CcAuth } from './cardcenter';

export type NoReservationInput = {
  buyOrderId: number;
  /** Lines of `<code>` or `<code>,<pin>`. */
  cardLines: string[];
};

export async function submitWithoutReservationUnconfirmed(
  auth: CcAuth,
  input: NoReservationInput,
): Promise<{ id: string }> {
  const rateRes = await ccApiFetch(auth.userId, auth.email, auth.password, `/Api/Rates/${input.buyOrderId}`);
  if (!rateRes.ok) throw new Error(`Rates/${input.buyOrderId} failed (${rateRes.status})`);
  const rate = await ccJson<{
    brand: unknown; value: number;
    sellerAgreement?: { agreement?: { id: string; date: string } };
  }>(rateRes, `Rates/${input.buyOrderId}`);
  // GUESS: the body of the reservation-based submit with the rate's id in place of `reservation`.
  const body = {
    groups: [{
      brand: rate.brand,
      value: rate.value,
      quantity: input.cardLines.length,
      buyOrder: { id: input.buyOrderId },
      cards: input.cardLines.map(code => ({ brand: rate.brand, value: rate.value, code })),
    }],
    ...(rate.sellerAgreement?.agreement ? { acceptAgreement: rate.sellerAgreement.agreement } : {}),
  };
  const res = await ccApiFetch(auth.userId, auth.email, auth.password, '/Api/Submissions', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Submissions failed (${res.status}): ${(await res.text().catch(() => '')).slice(0, 300)}`);
  return ccJson<{ id: string }>(res, 'Submissions');
}
