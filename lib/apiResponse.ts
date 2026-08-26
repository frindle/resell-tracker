/**
 * Reading a fetch Response without letting the parse failure become the error
 * the user sees.
 *
 * `res.json()` throws when the body is not JSON, and the message it throws is
 * about the parse, not about what went wrong: Safari words it "The string did
 * not match the expected pattern", Chrome "Unexpected end of JSON input", and
 * Firefox "JSON.parse: unexpected character". A handler that does
 * `catch (e) { setError(String(e)) }` then shows that string, and the HTTP
 * status -- the only part that says what actually happened -- is gone.
 *
 * Non-JSON bodies are normal, not exotic: a reverse proxy returns an HTML 502
 * or 504 page, an auth layer returns a redirect, a 204 returns nothing at all.
 *
 * Read the body ONCE as text and decide afterwards. A Response body can only be
 * consumed once, so `res.json()` in a try with `res.text()` in the catch cannot
 * work -- the catch gets "body stream already read", replacing one misleading
 * message with another.
 */

/** Structural subset of Response, so callers and tests need no DOM lib. */
export interface ReadableResponse {
  ok: boolean;
  status: number;
  statusText?: string;
  text(): Promise<string>;
}

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; message: string };

/** Longest server-supplied detail we put in front of a user. */
const MAX_DETAIL = 200;

/**
 * Turns an HTML error page into one line worth reading. Prefers <title>, which
 * is where nginx and Cloudflare put "504 Gateway Time-out", and otherwise
 * strips tags. Returns '' when nothing useful survives, so the caller falls
 * back to the status rather than showing a fragment of markup.
 */
function summarizeNonJson(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return '';

  const looksLikeMarkup = /^\s*(<!doctype|<html|<\?xml)/i.test(trimmed);
  if (looksLikeMarkup) {
    const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(trimmed)?.[1] ?? '';
    const collapsed = title.replace(/\s+/g, ' ').trim();
    if (collapsed) return collapsed.slice(0, MAX_DETAIL);
  }

  const stripped = trimmed
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return stripped.slice(0, MAX_DETAIL);
}

function httpLabel(status: number, statusText?: string): string {
  const suffix = statusText?.trim() ? ` ${statusText.trim()}` : '';
  return `HTTP ${status}${suffix}`;
}

/**
 * Reads a response into either its parsed JSON or a message fit to display.
 *
 * An `ok` response with an unparseable body is a failure, not a success: a 200
 * carrying an HTML login page means the request did not do what was asked, and
 * handing the caller `{}` would let it report success. An empty body on an ok
 * response IS a success (204 and friends) and yields `{}`.
 *
 * `{ error }` in a JSON body wins over the status line, since routes here put
 * their real explanation there.
 */
export async function readApiResponse<T>(res: ReadableResponse): Promise<ApiResult<T>> {
  let text: string;
  try {
    text = await res.text();
  } catch (e) {
    // The socket died mid-body. There is no status worth quoting.
    return { ok: false, status: res.status, message: `${httpLabel(res.status, res.statusText)}: response could not be read (${String(e)})` };
  }

  let parsed: unknown;
  let parseOk = false;
  if (text.trim()) {
    try {
      parsed = JSON.parse(text);
      parseOk = true;
    } catch {
      parseOk = false;
    }
  }

  if (res.ok) {
    if (!text.trim()) return { ok: true, data: {} as T };
    if (parseOk) return { ok: true, data: parsed as T };
    const detail = summarizeNonJson(text);
    return {
      ok: false,
      status: res.status,
      message: `${httpLabel(res.status, res.statusText)}: server returned a non-JSON response${detail ? ` — ${detail}` : ''}`,
    };
  }

  const fromBody =
    parseOk && typeof parsed === 'object' && parsed !== null && typeof (parsed as { error?: unknown }).error === 'string'
      ? ((parsed as { error: string }).error).trim()
      : '';
  const detail = fromBody || summarizeNonJson(text);
  return {
    ok: false,
    status: res.status,
    message: `${httpLabel(res.status, res.statusText)}${detail ? `: ${detail}` : ''}`,
  };
}

/**
 * True when a failed request might still have taken effect on the far side.
 *
 * Gateway and network failures say nothing about whether the origin finished
 * its work. For a non-idempotent push this is the difference between "retry"
 * and "check first" -- BFMR records a shipment before this app hears back, so
 * a blind retry submits the same tracking number twice.
 */
export function mayHaveTakenEffect(status: number): boolean {
  return status === 0 || status === 408 || status === 502 || status === 503 || status === 504 || status >= 520;
}
