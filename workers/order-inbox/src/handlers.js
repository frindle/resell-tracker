// Pure handler logic for the order-inbox worker. Everything takes its
// dependencies (KV namespace, secrets) as arguments so it can be tested with a
// fake KV object.

export const MAX_RAW_BYTES = 24 * 1024 * 1024;
export const TTL_SECONDS = 30 * 24 * 60 * 60;
export const KEY_PREFIX = 'm:';
export const MAX_LIMIT = 100;

/** Read a ReadableStream fully; null when it exceeds `max` bytes. */
export async function readStream(stream, max) {
  const reader = stream.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.byteLength; }
  return out;
}

/** Email Routing entry point. */
export async function handleEmail(message, env, now = new Date(), uuid = () => crypto.randomUUID()) {
  // The declared size is a cheap early reject; the streamed read is the real cap.
  if (typeof message.rawSize === 'number' && message.rawSize > MAX_RAW_BYTES) {
    message.setReject('message too large');
    return null;
  }
  const raw = await readStream(message.raw, MAX_RAW_BYTES);
  if (!raw) {
    message.setReject('message too large');
    return null;
  }
  const receivedAt = now.toISOString();
  const key = `${KEY_PREFIX}${receivedAt}:${uuid()}`;
  await env.ORDER_MAIL.put(key, raw, {
    expirationTtl: TTL_SECONDS,
    metadata: { to: message.to, from: message.from, size: raw.byteLength, receivedAt },
  });
  return key;
}

/** Constant-time string compare (digests both sides so length does not leak). */
export async function safeEqual(a, b) {
  const enc = new TextEncoder();
  const [da, db] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  const x = new Uint8Array(da);
  const y = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

export async function authorized(request, env) {
  const token = env.PULL_TOKEN;
  if (!token) return false;
  const header = request.headers.get('Authorization') ?? '';
  const m = /^Bearer (.+)$/.exec(header);
  if (!m) return false;
  return safeEqual(m[1], token);
}

// ---------------------------------------------------------------------------
// addy.io rule webhooks
//
// addy.io Rules (Lite and Pro) can POST each accepted email to an https URL.
// Pointing a rule at /addy/<local> stores the mail as if it had arrived at
// <local>@<orders domain>, so the tracker routes it like routed mail. The
// payload carries the original From, subject, text/html bodies and headers
// (never attachments); the tracker's parser needs nothing else.
// ---------------------------------------------------------------------------

export const ADDY_PATH = '/addy/';
// addy caps bodies and headers at 1 MiB each; leave room for JSON overhead.
export const MAX_WEBHOOK_BYTES = 4 * 1024 * 1024;
// Structural headers describe the original MIME tree, which the payload no
// longer has; the rebuilt message supplies its own.
const DROP_HEADERS = new Set([
  'content-type', 'content-transfer-encoding', 'mime-version', 'content-length',
  'content-disposition', 'content-id', 'content-description', 'bcc',
]);

function hex(buf) {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** HMAC-SHA256 of `body` keyed by the secret string, as lowercase hex. */
export async function hmacHex(secret, body) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, typeof body === 'string' ? enc.encode(body) : body));
}

/** The orders address for a webhook path segment, or null when unknown. */
export function addyRecipient(env, local) {
  const want = String(local ?? '').toLowerCase();
  if (!/^[a-z0-9._-]+$/.test(want)) return null;
  for (const a of String(env.ADDY_RECIPIENTS ?? '').split(',')) {
    const addr = a.trim().toLowerCase();
    if (addr && addr.split('@')[0] === want) return addr;
  }
  return null;
}

function b64(s) {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/.{1,76}/g, '$&\r\n');
}

/** One header line, unfolded, with CR/LF removed (values may be UTF-8). */
function headerLine(name, value) {
  return `${name}: ${String(value).replace(/[\r\n]+/g, ' ').trim()}`;
}

/**
 * Rebuild a MIME message from an addy payload: its original headers (minus the
 * structural ones) over a fresh text/html body.
 */
export function addyMime(p, recipient, boundary = `addy-${crypto.randomUUID()}`) {
  const lines = [];
  const seen = new Set();
  for (const h of Array.isArray(p.headers) ? p.headers : []) {
    const name = String(h?.name ?? '').toLowerCase();
    if (!/^[!-9;-~]+$/.test(name) || DROP_HEADERS.has(name)) continue;
    seen.add(name);
    lines.push(headerLine(name, h.value ?? ''));
  }
  if (!seen.has('from') && p.from) lines.push(headerLine('from', p.from));
  if (!seen.has('subject')) lines.push(headerLine('subject', p.subject ?? ''));
  if (!seen.has('message-id') && p.message_id) lines.push(headerLine('message-id', `<${p.message_id}>`));
  if (!seen.has('date') && p.received_at) lines.push(headerLine('date', new Date(p.received_at).toUTCString()));
  lines.push(headerLine('delivered-to', recipient));
  if (p.alias?.email) lines.push(headerLine('x-addy-alias', p.alias.email));
  lines.push('MIME-Version: 1.0');

  const text = typeof p.text === 'string' ? p.text : '';
  const html = typeof p.html === 'string' ? p.html : '';
  const part = (type, body) => [`Content-Type: ${type}; charset=utf-8`, 'Content-Transfer-Encoding: base64', '', b64(body)].join('\r\n');
  if (text && html) {
    lines.push(`Content-Type: multipart/alternative; boundary="${boundary}"`, '',
      `--${boundary}`, part('text/plain', text), `--${boundary}`, part('text/html', html), `--${boundary}--`, '');
  } else {
    lines.push(html && !text ? part('text/html', html) : part('text/plain', text));
  }
  return lines.join('\r\n');
}

/**
 * POST /addy/<local>: verify X-Addy-Signature, store forwarded mail. 4xx is
 * final for addy (no retry); a thrown KV error becomes a 5xx, which it retries.
 */
export async function handleAddyWebhook(request, env, now = new Date()) {
  const url = new URL(request.url);
  let local;
  try { local = decodeURIComponent(url.pathname.slice(ADDY_PATH.length)); } catch { return new Response('Not found', { status: 404 }); }
  const recipient = addyRecipient(env, local);
  if (!recipient) return new Response('Not found', { status: 404 });
  const secret = env[`ADDY_WEBHOOK_SECRET_${local.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`] || env.ADDY_WEBHOOK_SECRET;
  if (!secret) return new Response('Not configured', { status: 404 });

  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > MAX_WEBHOOK_BYTES) return new Response('Too large', { status: 413 });
  const body = request.body ? await readStream(request.body, MAX_WEBHOOK_BYTES) : new Uint8Array();
  if (!body) return new Response('Too large', { status: 413 });

  const sig = (request.headers.get('x-addy-signature') ?? '').trim().toLowerCase();
  if (!sig || !(await safeEqual(sig, await hmacHex(secret, body)))) {
    return new Response('Bad signature', { status: 401 });
  }

  let p;
  try { p = JSON.parse(new TextDecoder().decode(body)); } catch { return new Response('Bad JSON', { status: 400 }); }
  if (!p || typeof p !== 'object') return new Response('Bad JSON', { status: 400 });
  // Only mail arriving at an alias; replies/sends from an alias are outbound.
  if (p.event !== 'alias.email.received' || p.email_type !== 'forward') return new Response(null, { status: 204 });

  // addy retries a delivery with the same payload, so key on its id and
  // received_at: a retry overwrites instead of duplicating.
  const at = new Date(p.received_at ?? '');
  const receivedAt = Number.isNaN(at.getTime()) ? now.toISOString() : at.toISOString();
  const id = /^[a-f0-9]{16,128}$/i.test(String(p.id ?? '')) ? String(p.id).toLowerCase() : crypto.randomUUID();
  const raw = new TextEncoder().encode(addyMime(p, recipient));
  const key = `${KEY_PREFIX}${receivedAt}:addy-${id}`;
  await env.ORDER_MAIL.put(key, raw, {
    expirationTtl: TTL_SECONDS,
    metadata: { to: recipient, from: typeof p.from === 'string' ? p.from : '', size: raw.byteLength, receivedAt },
  });
  return new Response(null, { status: 204 });
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** HTTP pull API. */
export async function handleFetch(request, env) {
  // addy.io cannot send a bearer token; its webhooks are HMAC-signed instead.
  if (request.method === 'POST' && new URL(request.url).pathname.startsWith(ADDY_PATH)) {
    return handleAddyWebhook(request, env);
  }
  if (!(await authorized(request, env))) {
    return new Response('Unauthorized', { status: 401, headers: { 'www-authenticate': 'Bearer' } });
  }
  const url = new URL(request.url);

  if (url.pathname === '/messages') {
    if (request.method !== 'GET') return new Response('Not found', { status: 404 });
    const n = Number.parseInt(url.searchParams.get('limit') ?? '', 10);
    const limit = Number.isFinite(n) && n > 0 ? Math.min(n, MAX_LIMIT) : MAX_LIMIT;
    const cursor = url.searchParams.get('cursor') || undefined;
    const res = await env.ORDER_MAIL.list({ prefix: KEY_PREFIX, limit, cursor });
    const messages = res.keys.map(k => ({
      id: k.name,
      to: k.metadata?.to ?? '',
      from: k.metadata?.from ?? '',
      size: k.metadata?.size ?? 0,
      receivedAt: k.metadata?.receivedAt ?? '',
    }));
    return json({ messages, cursor: res.list_complete ? null : (res.cursor ?? null), complete: Boolean(res.list_complete) });
  }

  if (url.pathname.startsWith('/messages/')) {
    let id;
    try { id = decodeURIComponent(url.pathname.slice('/messages/'.length)); } catch { return new Response('Not found', { status: 404 }); }
    if (!id.startsWith(KEY_PREFIX)) return new Response('Not found', { status: 404 });

    if (request.method === 'GET') {
      const raw = await env.ORDER_MAIL.get(id, 'arrayBuffer');
      if (!raw) return new Response('Not found', { status: 404 });
      return new Response(raw, { status: 200, headers: { 'content-type': 'message/rfc822' } });
    }
    if (request.method === 'DELETE') {
      await env.ORDER_MAIL.delete(id);
      return new Response(null, { status: 204 });
    }
  }
  return new Response('Not found', { status: 404 });
}
