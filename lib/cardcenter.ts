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

async function getReservations(token: string): Promise<CcReservation[]> {
  const res = await fetch(`${BASE_URL}/Api/Reservations`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Failed to fetch reservations (${res.status})`);
  const data = await res.json() as { items?: CcReservation[] } | CcReservation[];
  return Array.isArray(data) ? data : (data.items ?? []);
}

async function getAcceptAgreement(token: string): Promise<{ id: string; date: string }> {
  const res = await fetch(`${BASE_URL}/Api/PotentialSubmissions`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ cards: [] }),
  });
  if (!res.ok) throw new Error(`Failed to fetch agreement (${res.status})`);
  const data = await res.json() as { sellerAgreement?: { agreement?: { id: string; date: string } } };
  const agreement = data?.sellerAgreement?.agreement;
  if (!agreement?.id) throw new Error('Could not find seller agreement in PotentialSubmissions');
  return agreement;
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
  cards: Array<{ id: number; code: string; merchant: string; value: number }>,
): Promise<CcSubmitResult> {
  const result: CcSubmitResult = { submitted: [], duplicate: [], failed: [] };

  const [reservations, acceptAgreement] = await Promise.all([
    getReservations(token),
    getAcceptAgreement(token),
  ]);

  // Sort by submission deadline — use most urgent reservations first
  const available = reservations
    .filter(r => !r.expired && r.status === 'Approved' && r.permissions?.submit !== false)
    .sort((a, b) => new Date(a.submissionDeadline).getTime() - new Date(b.submissionDeadline).getTime());

  // Match each card to a unique reservation (avoid reusing the same reservation for two cards)
  const usedReservationIds = new Set<number>();
  type MatchedCard = { id: number; code: string; value: number; brand: CcBrand; reservation: CcReservation };
  const matched: MatchedCard[] = [];

  for (const card of cards) {
    const reservation = available.find(r =>
      r.brand.name.toLowerCase() === card.merchant.toLowerCase() &&
      Math.abs(r.value - card.value) < 0.01 &&
      !usedReservationIds.has(r.id)
    );
    if (!reservation) {
      result.failed.push(card.id);
      result.rawError = (result.rawError ? result.rawError + '; ' : '') +
        `No open reservation for ${card.merchant} $${card.value}`;
      continue;
    }
    usedReservationIds.add(reservation.id);
    matched.push({ id: card.id, code: card.code, value: card.value, brand: reservation.brand, reservation });
  }

  if (!matched.length) return result;

  // Group matched cards by brand for the payload
  const groups = new Map<number, { brand: CcBrand; cards: MatchedCard[] }>();
  for (const card of matched) {
    const brandId = card.brand.id;
    if (!groups.has(brandId)) groups.set(brandId, { brand: card.brand, cards: [] });
    groups.get(brandId)!.cards.push(card);
  }

  const seller = matched[0].reservation.seller;

  const payload = {
    seller,
    acceptAgreement,
    groups: Array.from(groups.values()).map(({ brand, cards: groupCards }) => ({
      brand,
      cards: groupCards.map(c => ({
        brand: c.brand,
        code: c.code,
        value: c.value,
        quantity: 1,
        reservation: c.reservation,
      })),
    })),
  };

  try {
    const res = await fetch(`${BASE_URL}/Api/Submissions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    });

    if (res.ok) {
      for (const c of matched) result.submitted.push(c.id);
    } else {
      const text = await res.text().catch(() => '');
      if (/already|duplicate|exist/i.test(text) || res.status === 409) {
        for (const c of matched) result.duplicate.push(c.id);
      } else {
        for (const c of matched) result.failed.push(c.id);
        result.rawError = text || String(res.status);
      }
    }
  } catch (e) {
    for (const c of matched) result.failed.push(c.id);
    result.rawError = String(e);
  }

  return result;
}
