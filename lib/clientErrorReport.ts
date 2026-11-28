// A page that fails in the browser (Next's "This page couldn't load") used to leave no trace on the server: the APIs
// answered 200 and the render broke on the data. app/error.tsx and app/global-error.tsx now post what broke to
// /api/client-errors, which logs it ([client-error] in the container log) and keeps it on the API errors page.
// Pure: the report's shape, and the once-per-window rule that keeps a render loop from flooding either.

export type ClientErrorReport = { path: string; message: string; stack: string; digest: string };

const cut = (v: unknown, n: number) => (typeof v === 'string' ? v : '').replace(/\s+$/g, '').slice(0, n);

/** What the server keeps of a posted report: strings only, cut short; the path without its query. */
export function cleanClientError(raw: unknown): ClientErrorReport | null {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const message = cut(r.message, 300);
  if (!message) return null;
  const path = cut(r.path, 200).split(/[?#]/)[0] || '/';
  return { path, message, stack: cut(r.stack, 1500), digest: cut(r.digest, 40) };
}

/** Same page and message within this many ms: logged once. */
export const CLIENT_ERROR_WINDOW_MS = 10 * 60 * 1000;

/** True when this report should be logged now; records it. `seen` maps a key to when it was last logged. */
export function shouldLogClientError(seen: Map<string, number>, r: ClientErrorReport, now: number): boolean {
  const key = `${r.path}\n${r.message}`;
  const last = seen.get(key);
  if (last != null && now - last < CLIENT_ERROR_WINDOW_MS) return false;
  seen.set(key, now);
  if (seen.size > 500) for (const [k, t] of seen) if (now - t >= CLIENT_ERROR_WINDOW_MS) seen.delete(k);
  return true;
}
