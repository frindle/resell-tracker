// Validates the body of BuyingGroup's /commitment/get_commitments. Pure (no
// imports) so it is unit-testable. Fails loudly: a non-SUCCESS status or a
// missing/malformed payload must not look like "no commitments". The error
// names the endpoint, status and message only -- never the bearer token or
// any request header.
export function parseCommitmentsResponse<C>(data: unknown): { commitments: C[]; count: number } {
  const body = (data ?? {}) as { status?: unknown; message?: unknown; payload?: { commitments?: unknown; count?: unknown } | null };
  const endpoint = '/commitment/get_commitments';
  if (body.status !== undefined && body.status !== 'SUCCESS') {
    throw new Error(`BuyingGroup API ${endpoint} returned status ${String(body.status)}: ${String(body.message ?? '')}`);
  }
  const commitments = body.payload?.commitments;
  if (!Array.isArray(commitments)) {
    throw new Error(`BuyingGroup API ${endpoint} returned an invalid payload (status ${String(body.status ?? 'missing')}): ${String(body.message ?? '')}`);
  }
  return { commitments: commitments as C[], count: typeof body.payload?.count === 'number' ? body.payload.count : 0 };
}
