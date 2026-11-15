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

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** HTTP pull API. */
export async function handleFetch(request, env) {
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
