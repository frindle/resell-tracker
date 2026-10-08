// Validates the body of BuyingGroup's /commitment/get_commitments. Pure (no
// imports) so it is unit-testable. Fails loudly: a non-SUCCESS status or a
// missing/malformed payload must not look like "no commitments". The error
// names the endpoint, status and message only -- never the bearer token or
// any request header.
// Key names and value types only, two levels deep -- never values -- so an
// upstream schema change is diagnosable from the error without leaking data.
export function describeShape(data: unknown): string {
  const t = (v: unknown) => (v === null ? 'null' : Array.isArray(v) ? `array(${v.length})` : typeof v);
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return t(data);
  return Object.entries(data as Record<string, unknown>).map(([k, v]) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return `${k}:{${Object.entries(v as Record<string, unknown>).map(([k2, v2]) => `${k2}:${t(v2)}`).join(',')}}`;
    }
    return `${k}:${t(v)}`;
  }).join(' ');
}

export function parseCommitmentsResponse<C>(data: unknown): { commitments: C[]; count: number } {
  const body = (data ?? {}) as { status?: unknown; message?: unknown; payload?: { commitments?: unknown; count?: unknown } | null };
  const endpoint = '/commitment/get_commitments';
  if (body.status !== undefined && body.status !== 'SUCCESS') {
    throw new Error(`BuyingGroup API ${endpoint} returned status ${String(body.status)}: ${String(body.message ?? '')}`);
  }
  const commitments = body.payload?.commitments;
  if (!Array.isArray(commitments)) {
    throw new Error(`BuyingGroup API ${endpoint} returned an invalid payload (status ${String(body.status ?? 'missing')}): ${String(body.message ?? '')} [shape: ${describeShape(data)}]`);
  }
  return { commitments: commitments as C[], count: typeof body.payload?.count === 'number' ? body.payload.count : 0 };
}
