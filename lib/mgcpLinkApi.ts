// Request handling for /api/orders/[id]/mgcp-links, dependency-injected for
// node:test. Links are secrets: the browser API never returns them (only the
// sidecar can, through the extension-authenticated route), they are never
// logged, and errors never echo them. Every response is no-store.

import { createHash } from 'node:crypto';
import { parseMgcpLink, maskMgcpLink, splitMgcpLinks } from './mgcpLinkParse.ts';

export type MgcpRow = { id: number; status: string; giftCardId: number | null; updatedAt: Date | null };

export type MgcpDeps = {
  getSessionUserId: () => Promise<number | null | undefined>;
  orderVisibleTo: (orderId: number, userId: number | null) => Promise<boolean>;
  requireOrderUnlocked: (orderId: number, userId: number | null) => Promise<Response | null>;
  listLinks: (orderId: number) => Promise<MgcpRow[]>;
  // Returns false when (orderId, linkHash) already exists.
  createLink: (orderId: number, linkEnc: string, linkHash: string) => Promise<boolean>;
  deleteLink: (orderId: number, linkId: number) => Promise<unknown>;
  encrypt: (plaintext: string) => string;
};

const NO_STORE = { 'Cache-Control': 'no-store' };
const MAX_LINKS_PER_REQUEST = 50;

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE });
}
function withNoStore(res: Response): Response {
  const h = new Headers(res.headers);
  h.set('Cache-Control', 'no-store');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}
export function hashMgcpLink(normalized: string): string {
  return createHash('sha256').update(normalized).digest('hex');
}

async function resolveOrder(deps: MgcpDeps, rawId: string): Promise<{ orderId: number; userId: number | null } | Response> {
  const userId = (await deps.getSessionUserId()) ?? null;
  const orderId = Number(rawId);
  if (!Number.isInteger(orderId) || orderId <= 0) return json({ error: 'Not found' }, 404);
  if (!(await deps.orderVisibleTo(orderId, userId))) return json({ error: 'Not found' }, 404);
  return { orderId, userId };
}

const fail = () => json({ error: 'Internal error' }, 500);

export async function handleGet(deps: MgcpDeps, _req: Request, rawId: string): Promise<Response> {
  try {
    const r = await resolveOrder(deps, rawId);
    if (r instanceof Response) return r;
    const rows = await deps.listLinks(r.orderId);
    return json({
      links: rows.map((l) => ({
        id: l.id,
        masked: maskMgcpLink(),
        status: l.status,
        giftCardId: l.giftCardId,
        updatedAt: l.updatedAt ? l.updatedAt.toISOString() : null,
      })),
    });
  } catch {
    return fail();
  }
}

async function readLinks(req: Request): Promise<string[] | undefined> {
  const body = (await req.json()) as { links?: unknown; text?: unknown } | null;
  if (Array.isArray(body?.links)) return body.links.filter((x): x is string => typeof x === 'string');
  if (typeof body?.text === 'string') return splitMgcpLinks(body.text);
  return undefined;
}

export async function handlePost(deps: MgcpDeps, req: Request, rawId: string): Promise<Response> {
  try {
    const r = await resolveOrder(deps, rawId);
    if (r instanceof Response) return r;
    const lock = await deps.requireOrderUnlocked(r.orderId, r.userId);
    if (lock) return withNoStore(lock);

    let links: string[] | undefined;
    try {
      links = await readLinks(req);
    } catch {
      return json({ error: 'Invalid request body' }, 400);
    }
    if (!links || links.length === 0) return json({ error: 'Missing links' }, 400);
    if (links.length > MAX_LINKS_PER_REQUEST) return json({ error: 'Too many links' }, 400);

    let added = 0;
    let duplicates = 0;
    const invalid: { index: number; error: string }[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < links.length; i++) {
      const p = parseMgcpLink(links[i]);
      if (!p.ok) { invalid.push({ index: i, error: p.error }); continue; }
      const h = hashMgcpLink(p.normalized);
      if (seen.has(h)) { duplicates++; continue; }
      seen.add(h);
      const created = await deps.createLink(r.orderId, deps.encrypt(p.normalized), h);
      if (created) added++; else duplicates++;
    }
    return json({ added, duplicates, invalid });
  } catch {
    return fail();
  }
}

export async function handleDelete(deps: MgcpDeps, req: Request, rawId: string): Promise<Response> {
  try {
    const r = await resolveOrder(deps, rawId);
    if (r instanceof Response) return r;
    const lock = await deps.requireOrderUnlocked(r.orderId, r.userId);
    if (lock) return withNoStore(lock);
    const linkId = Number(new URL(req.url).searchParams.get('linkId'));
    if (!Number.isInteger(linkId) || linkId <= 0) return json({ error: 'Missing linkId' }, 400);
    await deps.deleteLink(r.orderId, linkId);
    return json({ ok: true });
  } catch {
    return fail();
  }
}
