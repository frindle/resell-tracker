// Validates the body of BuyingGroup's /commitment/get_commitments. Pure (no
// imports) so it is unit-testable. Fails loudly: a non-SUCCESS status or a
// missing/malformed payload must not look like "no commitments". Errors name
// the endpoint, status, message and key names/types only -- never values, the
// bearer token or any request header.
//
// Two payload formats are accepted:
//   legacy (until ~2026-09-24): payload { commitments: [...], count }
//   current:                    payload { mode, items: [...], pagination: {...} }
// For the current format the total comes from pagination (total / total_count /
// count / total_items) when present; otherwise `count` is null and the caller
// pages until an empty or all-duplicate page.

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

const TOTAL_KEYS = ['total', 'total_count', 'count', 'total_items', 'totalCount'];

export function parseCommitmentsResponse<C>(data: unknown): { commitments: C[]; count: number | null } {
  const body = (data ?? {}) as {
    status?: unknown; message?: unknown;
    payload?: { commitments?: unknown; items?: unknown; count?: unknown; pagination?: Record<string, unknown> | null } | null;
  };
  const endpoint = '/commitment/get_commitments';
  if (body.status !== undefined && body.status !== 'SUCCESS') {
    throw new Error(`BuyingGroup API ${endpoint} returned status ${String(body.status)}: ${String(body.message ?? '')}`);
  }
  const p = body.payload;
  const list = Array.isArray(p?.commitments) ? p.commitments : Array.isArray(p?.items) ? p.items : null;
  if (!list) {
    throw new Error(`BuyingGroup API ${endpoint} returned an invalid payload (status ${String(body.status ?? 'missing')}): ${String(body.message ?? '')} [shape: ${describeShape(data)}]`);
  }
  const first = list[0] as Record<string, unknown> | undefined;
  if (first && (typeof first !== 'object' || typeof first.commitment_id !== 'string')) {
    throw new Error(`BuyingGroup API ${endpoint} returned rows without commitment_id [row shape: ${describeShape(first)}] [pagination: ${describeShape(p?.pagination ?? null)}]`);
  }
  let count: number | null = typeof p?.count === 'number' ? p.count : null;
  if (count == null && p?.pagination && typeof p.pagination === 'object') {
    for (const k of TOTAL_KEYS) {
      const v = p.pagination[k];
      if (typeof v === 'number') { count = v; break; }
    }
  }
  return { commitments: list as C[], count };
}
