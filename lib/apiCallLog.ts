import { prisma } from '@/lib/db';

// Records every outbound call to a third-party integration, success or
// failure -- the raw forensic trail. See ApiCallLog in schema.prisma for
// why this exists separately from ApiError (which only holds actionable
// failures for the user-facing /api-errors review queue). Never throws,
// safe to call from anywhere.
export async function logApiCall(input: {
  userId: number | null;
  group: string;
  endpoint: string;
  method: string;
  status?: number | null;
  requestBody?: string | null;
  responseBody?: string | null;
  durationMs?: number;
}): Promise<void> {
  try {
    await prisma.apiCallLog.create({
      data: {
        userId: input.userId ?? null,
        group: input.group,
        endpoint: input.endpoint.slice(0, 500),
        method: input.method,
        status: input.status ?? null,
        requestBody: input.requestBody ? input.requestBody.slice(0, 2000) : null,
        responseBody: input.responseBody ? input.responseBody.slice(0, 2000) : null,
        durationMs: input.durationMs ?? null,
      },
    });
  } catch (e) {
    console.error('[apiCallLog] failed to persist:', String(e).slice(0, 200));
  }
}

// Thin wrapper around fetch() that logs the call (request/response body,
// status, timing) via logApiCall before returning the real Response,
// unchanged, to the caller. Drop-in replacement for integration modules
// that currently call the global fetch() directly against a third-party
// API -- swap `fetch(url, opts)` for `loggedFetch({ group, userId }, url,
// opts)`. Logs even on a thrown network error (status left null) before
// re-throwing, so a failed call still leaves a trail.
export async function loggedFetch(
  meta: { group: string; userId: number | null },
  url: string,
  opts: RequestInit = {},
): Promise<Response> {
  const start = Date.now();
  const method = opts.method ?? 'GET';
  let reqBodyStr: string | null = null;
  if (typeof opts.body === 'string') reqBodyStr = opts.body;

  try {
    const res = await fetch(url, opts);
    // Clone before reading so the caller's own res.json()/res.text() still
    // sees a fresh, unconsumed body.
    const resBodyStr = await res.clone().text().catch(() => null);
    void logApiCall({
      userId: meta.userId,
      group: meta.group,
      endpoint: url,
      method,
      status: res.status,
      requestBody: reqBodyStr,
      responseBody: resBodyStr,
      durationMs: Date.now() - start,
    });
    return res;
  } catch (e) {
    void logApiCall({
      userId: meta.userId,
      group: meta.group,
      endpoint: url,
      method,
      status: null,
      requestBody: reqBodyStr,
      responseBody: String(e).slice(0, 2000),
      durationMs: Date.now() - start,
    });
    throw e;
  }
}

// Rolling 7-day retention -- called once at startup and every 6h from
// instrumentation.ts, matching the existing pattern for other periodic
// jobs in this file (runBgReceiptSync, startDbBackup, etc).
export async function pruneApiCallLog(retentionDays = 7): Promise<void> {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  try {
    const { count } = await prisma.apiCallLog.deleteMany({ where: { createdAt: { lt: cutoff } } });
    if (count > 0) console.log(`[apiCallLog] pruned ${count} entries older than ${retentionDays}d`);
  } catch (e) {
    console.error('[apiCallLog] prune failed:', String(e).slice(0, 200));
  }
}

export function startApiCallLogRetention(): void {
  pruneApiCallLog();
  setInterval(() => pruneApiCallLog(), 6 * 60 * 60 * 1000);
}
