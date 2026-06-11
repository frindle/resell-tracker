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

export interface CcCard {
  brand: string;
  value: number;
  code: string;
  pin?: string;
}

export interface CcSubmitResult {
  submitted: number[];   // card IDs that succeeded
  duplicate: number[];   // card IDs CardCenter says are already submitted
  failed: number[];      // card IDs that errored
  rawError?: string;
}

export async function submitCards(
  token: string,
  cards: Array<CcCard & { id: number }>,
): Promise<CcSubmitResult> {
  const result: CcSubmitResult = { submitted: [], duplicate: [], failed: [] };

  // Submit one at a time so per-card errors can be attributed
  for (const card of cards) {
    try {
      const res = await fetch(`${BASE_URL}/Api/ParsedCards`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify([{ brand: card.brand, value: card.value, code: card.code, pin: card.pin ?? '' }]),
      });
      if (res.ok) {
        result.submitted.push(card.id);
      } else {
        const text = await res.text().catch(() => '');
        // CardCenter returns an error when a code was already submitted
        if (/already|duplicate|exist/i.test(text) || res.status === 409) {
          result.duplicate.push(card.id);
        } else {
          result.failed.push(card.id);
          result.rawError = text;
        }
      }
    } catch (e) {
      result.failed.push(card.id);
      result.rawError = String(e);
    }
  }

  return result;
}
