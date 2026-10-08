// Request handling for /api/orders/[id]/egift-link, with every dependency
// injected so it is unit-testable with plain node:test (the route file wires
// the real prisma / session / secrets implementations).
//
// The delivery link is a secret: it is only ever returned by GET ?reveal=1,
// never logged, never echoed in an error, and every response is no-store.

import { parseCostcoDeliveryLink, maskDeliveryLink, hashLink } from './egiftLink.ts';

export type EgiftRow = { linkEnc: string; updatedAt: Date | null };

export type EgiftDeps = {
  getSessionUserId: () => Promise<number | null | undefined>;
  // Must scope by the session user: returns true only if the order belongs to userId
  // (or to no user when userId is null/undefined).
  orderVisibleTo: (orderId: number, userId: number | null) => Promise<boolean>;
  // Returns a Response when the order is locked, otherwise null.
  requireOrderUnlocked: (orderId: number, userId: number | null) => Promise<Response | null>;
  findLink: (orderId: number) => Promise<EgiftRow | null>;
  upsertLink: (orderId: number, linkEnc: string, linkHash: string) => Promise<unknown>;
  deleteLink: (orderId: number) => Promise<unknown>;
  encrypt: (plaintext: string) => string;
  decrypt: (ciphertext: string) => string;
};

const NO_STORE = { 'Cache-Control': 'no-store' };

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

function withNoStore(res: Response): Response {
  const h = new Headers(res.headers);
  h.set('Cache-Control', 'no-store');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

async function resolveOrder(
  deps: EgiftDeps,
  rawId: string,
): Promise<{ orderId: number; userId: number | null } | Response> {
  const userId = (await deps.getSessionUserId()) ?? null;
  const orderId = Number(rawId);
  if (!Number.isInteger(orderId) || orderId <= 0) return json({ error: 'Not found' }, 404);
  if (!(await deps.orderVisibleTo(orderId, userId))) return json({ error: 'Not found' }, 404);
  return { orderId, userId };
}

// Errors never include the link or the underlying exception text (which could).
function fail(): Response {
  return json({ error: 'Internal error' }, 500);
}

export async function handleGet(deps: EgiftDeps, req: Request, rawId: string): Promise<Response> {
  try {
    const r = await resolveOrder(deps, rawId);
    if (r instanceof Response) return r;
    const row = await deps.findLink(r.orderId);
    if (!row) return json({ hasLink: false, masked: null, updatedAt: null });
    const reveal = new URL(req.url).searchParams.get('reveal') === '1';
    if (reveal) return json({ link: deps.decrypt(row.linkEnc) });
    return json({
      hasLink: true,
      masked: maskDeliveryLink(),
      updatedAt: row.updatedAt ? row.updatedAt.toISOString() : null,
    });
  } catch {
    return fail();
  }
}

async function readLink(req: Request): Promise<string | undefined> {
  const ct = req.headers.get('content-type') || '';
  if (ct.includes('multipart/form-data') || ct.includes('application/x-www-form-urlencoded')) {
    const v = (await req.formData()).get('link');
    return typeof v === 'string' ? v : undefined;
  }
  const body = (await req.json()) as { link?: unknown } | null;
  return typeof body?.link === 'string' ? body.link : undefined;
}

export async function handlePut(deps: EgiftDeps, req: Request, rawId: string): Promise<Response> {
  try {
    const r = await resolveOrder(deps, rawId);
    if (r instanceof Response) return r;
    const lock = await deps.requireOrderUnlocked(r.orderId, r.userId);
    if (lock) return withNoStore(lock);

    let link: string | undefined;
    try {
      link = await readLink(req);
    } catch {
      return json({ error: 'Invalid request body' }, 400);
    }
    if (!link) return json({ error: 'Missing link' }, 400);

    const parsed = parseCostcoDeliveryLink(link);
    if (!parsed.ok) return json({ error: parsed.error }, 400);

    await deps.upsertLink(r.orderId, deps.encrypt(parsed.normalized), hashLink(parsed.normalized));
    return json({ hasLink: true, masked: maskDeliveryLink() });
  } catch {
    return fail();
  }
}

export async function handleDelete(deps: EgiftDeps, _req: Request, rawId: string): Promise<Response> {
  try {
    const r = await resolveOrder(deps, rawId);
    if (r instanceof Response) return r;
    const lock = await deps.requireOrderUnlocked(r.orderId, r.userId);
    if (lock) return withNoStore(lock);
    await deps.deleteLink(r.orderId);
    return json({ ok: true });
  } catch {
    return fail();
  }
}
