// BFMR's web host (www.bfmr.com) sits behind an AWS WAF that blocks Node's
// default TLS cipher-list fingerprint: every server-side fetch() returns
// 403 text/html from 'awselb/2.0' even with a valid Bearer token, while curl
// (and Node with the OpenSSL default cipher list) gets through. So requests to
// that host go through node:https with {ciphers:'DEFAULT'} instead of fetch().
//
// Pure + dependency-injected (the request function is a parameter) so it is
// unit-testable with node:test and no network. lib/apiCallLog.ts wires it
// into loggedFetch; every other host keeps using global fetch.

import https from 'node:https';
import type { IncomingMessage, ClientRequest, RequestOptions } from 'node:http';

export function needsBrowserLikeTls(url: string): boolean {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return h === 'bfmr.com' || h === 'www.bfmr.com';
  } catch {
    return false;
  }
}

export function bfmrTlsConnectOptions(): { ciphers: string } {
  return { ciphers: 'DEFAULT' };
}

export type HttpsRequestFn = (
  url: URL,
  options: RequestOptions,
  cb: (res: IncomingMessage) => void,
) => ClientRequest;

let agent: https.Agent | undefined;
function getAgent(): https.Agent {
  return (agent ??= new https.Agent({ ...bfmrTlsConnectOptions(), keepAlive: true }));
}

function headersToRecord(h: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!h) return out;
  new Headers(h).forEach((v, k) => {
    out[k] = v;
  });
  return out;
}

// Statuses that must not carry a body in a Response.
const NULL_BODY = new Set([101, 204, 205, 304]);

export function httpsFetch(
  url: string,
  opts: RequestInit = {},
  requestFn: HttpsRequestFn = https.request as unknown as HttpsRequestFn,
  agentOverride?: https.Agent,
): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const signal = opts.signal ?? undefined;
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException('This operation was aborted', 'AbortError'));
      return;
    }
    const method = (opts.method ?? 'GET').toUpperCase();
    const headers = headersToRecord(opts.headers);
    const body = typeof opts.body === 'string' ? opts.body : opts.body == null ? undefined : String(opts.body);
    if (body !== undefined && !Object.keys(headers).some(k => k.toLowerCase() === 'content-length')) {
      headers['content-length'] = String(Buffer.byteLength(body));
    }
    let settled = false;
    const req = requestFn(
      new URL(url),
      { method, headers, agent: agentOverride ?? getAgent(), ...bfmrTlsConnectOptions() },
      res => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer | string) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        res.on('error', e => fail(e));
        res.on('end', () => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener('abort', onAbort);
          const rh = new Headers();
          for (const [k, v] of Object.entries(res.headers ?? {})) {
            if (Array.isArray(v)) v.forEach(x => rh.append(k, x));
            else if (v != null) rh.set(k, String(v));
          }
          const status = res.statusCode ?? 0;
          resolve(
            new Response(NULL_BODY.has(status) ? null : Buffer.concat(chunks), {
              status,
              statusText: res.statusMessage ?? '',
              headers: rh,
            }),
          );
        });
      },
    );
    function fail(e: unknown) {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      reject(e);
    }
    function onAbort() {
      const reason = signal?.reason ?? new DOMException('This operation was aborted', 'AbortError');
      try {
        req.destroy?.();
      } catch {
        /* already closed */
      }
      fail(reason);
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    req.on('error', fail);
    if (body !== undefined) req.write(body);
    req.end();
  });
}
