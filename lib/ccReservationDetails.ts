// Read-only shaping of a CardCenter /Api/Reservations item for the gift card
// submit panel, so the numbers worth deciding on (rate, payout per card and in
// total, terms, buyer) are shown before "Submit to this". Pure, no I/O.

export type CcReservationDetails = {
  buyerName: string | null;
  buyOrderId: number | null;
  /** Fraction, e.g. 0.85 for 85%. */
  rate: number | null;
  /** value * rate, per card. */
  payoutPerCard: number | null;
  payoutTotal: number | null;
  /** Days after submitting that payment is due. */
  paymentTerms: number | null;
  /** Days allowed to submit cards after reserving. */
  submissionTerms: number | null;
  flexType: string | null;
  status: string | null;
  reservedOn: string | null;
};

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const cents = (n: number) => Math.round(n * 100) / 100;

type RawReservation = {
  value?: unknown;
  quantity?: unknown;
  rate?: unknown;
  paymentTerms?: unknown;
  submissionTerms?: unknown;
  flexType?: unknown;
  status?: unknown;
  date?: unknown;
  buyOrder?: { id?: unknown; buyer?: { displayName?: unknown } } | null;
};

export function shapeReservationDetails(r: RawReservation): CcReservationDetails {
  const value = num(r.value);
  const qty = num(r.quantity);
  const rate = num(r.rate);
  const per = value != null && rate != null ? cents(value * rate) : null;
  return {
    buyerName: str(r.buyOrder?.buyer?.displayName),
    buyOrderId: num(r.buyOrder?.id),
    rate,
    payoutPerCard: per,
    payoutTotal: per != null && qty != null ? cents(per * qty) : null,
    paymentTerms: num(r.paymentTerms),
    submissionTerms: num(r.submissionTerms),
    flexType: str(r.flexType),
    status: str(r.status),
    reservedOn: str(r.date),
  };
}

/**
 * How many cards the panel is about to submit versus how many the reservation
 * wants. 'exact' | 'short' (fewer than wanted) | 'over' (more than wanted).
 */
export function cardCountFit(wanted: number, submitting: number): 'exact' | 'short' | 'over' {
  if (submitting === wanted) return 'exact';
  return submitting < wanted ? 'short' : 'over';
}
