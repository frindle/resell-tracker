// BFMR REST v2 my-tracker submit + post-submit verify (fetch injected; no imports on purpose).
// Port of the order-880 mismatch guard in lib/bfmrVerify.ts, keyed by reserve_id/purchase_id.

export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; json(): Promise<any>; text(): Promise<string> }>;

export type RestCreds = { apiKey: string; apiSecret: string };

export type RestRowKey = { reserveId: string; purchaseId?: string | null };

export type RestVerdict = 'ok' | 'pending' | 'mismatch' | 'not-found';

export async function submitTrackerRows(fetchImpl: FetchLike, creds: RestCreds, rows: Record<string, unknown>[]): Promise<{ valid: unknown[]; invalid: unknown[] }> {
  if (rows.length === 0 || rows.length > 500) {
    throw new Error('submitTrackerRows: 1-500 rows required');
  }
  const res = await fetchImpl('https://api.bfmr.com/api/v2/my-tracker', {
    method: 'POST',
    headers: {
      'API-KEY': creds.apiKey,
      'API-SECRET': creds.apiSecret,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ tracker_data: rows }),
  });
  if (!res.ok) {
    throw new Error('BFMR ' + res.status + ': ' + (await res.text()).slice(0, 200));
  }
  const body = await res.json();
  const rr = body.reservations_response;
  return {
    valid: Array.isArray(rr?.valid_items) ? rr.valid_items : [],
    invalid: Array.isArray(rr?.invalid_items) ? rr.invalid_items : [],
  };
}

export function classifyRestVerify(rows: Record<string, unknown>[], key: RestRowKey, expected: string): RestVerdict {
  const matching = rows.filter((row) => {
    if (String(row.reserve_id) !== key.reserveId) return false;
    if (key.purchaseId && String(key.purchaseId) !== '') {
      if (String(row.purchase_id) !== String(key.purchaseId)) return false;
    }
    return true;
  });
  if (matching.length === 0) return 'not-found';
  const trimmedExpected = expected.trim().toLowerCase();
  const hasMatch = matching.some((row) => {
    const tn = row.tracking_number;
    if (tn == null || typeof tn !== 'string') return false;
    return tn.trim().toLowerCase() === trimmedExpected;
  });
  if (hasMatch) return 'ok';
  const hasNonEmpty = matching.some((row) => {
    const tn = row.tracking_number;
    if (typeof tn === 'string' && tn.trim() !== '') return true;
    return false;
  });
  return hasNonEmpty ? 'mismatch' : 'pending';
}

export async function verifyByTrackings(
  fetchImpl: FetchLike,
  creds: RestCreds,
  key: RestRowKey,
  expected: string,
  opts: { attempts?: number; delayMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<{ verdict: RestVerdict; actual: string | null }> {
  const attempts = Math.max(1, opts.attempts ?? 3);
  const delayMs = opts.delayMs ?? 500;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  let lastResult: { verdict: RestVerdict; actual: string | null } = { verdict: 'not-found', actual: null };
  for (let i = 0; i < attempts; i++) {
    const params = new URLSearchParams();
    params.append('trackings[]', expected.trim());
    params.set('quick_filter', 'all');
    params.set('page_size', '100');
    const res = await fetchImpl('https://api.bfmr.com/api/v2/my-tracker?' + params.toString(), {
      method: 'GET',
      headers: {
        'API-KEY': creds.apiKey,
        'API-SECRET': creds.apiSecret,
      },
    });
    if (!res.ok) {
      throw new Error('BFMR ' + res.status + ': ' + (await res.text()).slice(0, 200));
    }
    const body = await res.json();
    const trackings = Array.isArray(body.my_tracker) ? body.my_tracker : [];
    lastResult = {
      verdict: classifyRestVerify(trackings as Record<string, unknown>[], key, expected),
      actual: (() => {
        const match = trackings.find((row: Record<string, unknown>) => {
          if (String(row.reserve_id) !== key.reserveId) return false;
          if (key.purchaseId && String(key.purchaseId) !== '') {
            if (String(row.purchase_id) !== String(key.purchaseId)) return false;
          }
          return true;
        });
        if (!match) return null;
        const tn = (match.tracking_number as string) ?? '';
        return tn.trim();
      })(),
    };
    if (lastResult.verdict === 'ok' || lastResult.verdict === 'mismatch') break;
    if (i < attempts - 1) {
      await sleep(delayMs);
    }
  }
  return lastResult;
}
