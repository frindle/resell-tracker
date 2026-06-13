const BASE_URL = 'https://cardcenter.cc';

export async function getCcToken(email: string, password: string): Promise<string> {
  const res = await fetch(`${BASE_URL}/Api/Tokens`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => String(res.status));
    throw new Error(`Auth failed (${res.status}): ${text}`);
  }
  const data = await res.json() as Record<string, unknown>;
  const token = data.token ?? data.accessToken ?? data.access_token;
  if (!token) throw new Error('No token in CardCenter response');
  return String(token);
}

interface CcBrand {
  id: number;
  name: string;
  slug: string;
  type: string;
  image: { id: string };
}

interface CcReservation {
  id: number;
  date: string;
  seller: { id: number; email: string };
  brand: CcBrand;
  buyOrder: { id: number; value: number; brand: CcBrand; buyer: { id: number; displayName: string; email: string } };
  value: number;
  quantity: number;
  rate: number;
  submissionTerms: number;
  paymentTerms: number;
  flexType: string;
  status: string;
  expired: boolean;
  submissionDeadline: string;
  submissionToken: string;
  permissions: Record<string, boolean>;
}


export interface CcPaymentListing {
  id: number;
  amount: number;
  listing: {
    giftCard: { id: number };
    value: number;
    brand: CcBrand;
    purchasePrice: number;
    purchasePaid: number;
  };
}

export interface CcPayment {
  id?: number;
  name: string;
  amount: number;
  status: string;
  date: string;
  receivedOn: string;
  listings?: CcPaymentListing[];
}

export async function getPaymentDetail(token: string, paymentId: string): Promise<CcPayment> {
  const res = await fetch(`${BASE_URL}/Api/Payments/${encodeURIComponent(paymentId)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`CardCenter payment ${res.status}`);
  return res.json() as Promise<CcPayment>;
}

export interface CcSubmitResult {
  submitted: number[];   // card IDs that succeeded
  duplicate: number[];   // card IDs CardCenter says are already submitted
  failed: number[];      // card IDs that errored
  rawError?: string;
}

export async function submitCards(
  token: string,
  cards: Array<{ id: number; code: string; merchant: string; value: number; ccReservationId: number | null }>,
): Promise<CcSubmitResult> {
  const result: CcSubmitResult = { submitted: [], duplicate: [], failed: [] };

  // Group by ccReservationId; cards without one are failed immediately
  const byReservation = new Map<number, typeof cards>();
  for (const card of cards) {
    if (!card.ccReservationId) {
      result.failed.push(card.id);
      if (!result.rawError) result.rawError = 'Some cards have no reservation — create one first';
      continue;
    }
    if (!byReservation.has(card.ccReservationId)) byReservation.set(card.ccReservationId, []);
    byReservation.get(card.ccReservationId)!.push(card);
  }

  for (const [reservationId, groupCards] of byReservation) {
    try {
      // Fetch the full reservation to get seller info
      const reservationRes = await fetch(`${BASE_URL}/Api/Reservations/${reservationId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!reservationRes.ok) {
        for (const c of groupCards) result.failed.push(c.id);
        result.rawError = `Reservation ${reservationId} not found (${reservationRes.status})`;
        continue;
      }
      const reservation = await reservationRes.json() as CcReservation & {
        submissionInstructions?: unknown;
        sellerAgreement?: unknown;
      };

      // Parse card codes — CardCenter validates them and returns the submission structure
      const codes = groupCards.map(c => c.code).join('\n');
      const parseRes = await fetch(`${BASE_URL}/Api/Reservations/${reservationId}/ParsedCards`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: codes }),
      });
      if (!parseRes.ok) {
        const text = await parseRes.text().catch(() => String(parseRes.status));
        for (const c of groupCards) result.failed.push(c.id);
        result.rawError = `ParsedCards failed: ${text}`;
        continue;
      }
      const parsed = await parseRes.json() as {
        submission: { groups: unknown[] };
      };

      // Submit using seller from reservation + groups from ParsedCards
      const submitRes = await fetch(`${BASE_URL}/Api/Submissions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ seller: reservation.seller, groups: parsed.submission.groups }),
      });

      if (submitRes.ok) {
        for (const c of groupCards) result.submitted.push(c.id);
      } else {
        const text = await submitRes.text().catch(() => '');
        if (submitRes.status === 409 || /already|duplicate|exist/i.test(text)) {
          for (const c of groupCards) result.duplicate.push(c.id);
        } else {
          for (const c of groupCards) result.failed.push(c.id);
          result.rawError = text || String(submitRes.status);
        }
      }
    } catch (e) {
      for (const c of groupCards) result.failed.push(c.id);
      result.rawError = String(e);
    }
  }

  return result;
}
