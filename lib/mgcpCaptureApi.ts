// Sidecar-facing MGCP capture API (extension-secret authenticated), with all
// dependencies injected for node:test.
//   GET   ?orderId=N  -> uncaptured links for the order, DECRYPTED (the only
//                        place a link leaves the server; sidecar-only, no-store)
//   POST  multipart   -> save one captured card (+ page PDF + barcode image)
//   PATCH json        -> record a link outcome ('failed' | 'pending')
// Card numbers, PINs and links are never logged or echoed in errors.

import { sniffUpload, uploadProblem } from './uploadSniff.ts';

export type CaptureLink = { id: number; linkEnc: string; status: string };

export type CaptureDeps = {
  authorize: (req: Request) => number | null; // acting userId, or null if unauthorised
  orderVisibleTo: (orderId: number, userId: number) => Promise<boolean>;
  listOpenLinks: (orderId: number) => Promise<CaptureLink[]>;
  findLink: (orderId: number, linkId: number) => Promise<CaptureLink | null>;
  setLinkStatus: (orderId: number, linkId: number, status: string) => Promise<unknown>;
  // Persist file, return its stored name. Throws on failure.
  saveFile: (orderId: number, file: File) => Promise<string>;
  // One atomic write: gift card + attachments + link->captured. Returns giftCardId.
  commitCapture: (a: {
    orderId: number; linkId: number; merchant: string; value: number;
    cardNumber: string; pin: string | null;
    files: Array<{ filename: string; originalName: string; mimeType: string }>;
  }) => Promise<number>;
  decrypt: (c: string) => string;
};

const NO_STORE = { 'Cache-Control': 'no-store' };
const json = (b: unknown, s = 200) => Response.json(b, { status: s, headers: NO_STORE });
const fail = () => json({ error: 'Internal error' }, 500);
const strip = (s: string) => s.replace(/\s+/g, '');

async function guard(deps: CaptureDeps, req: Request, rawOrderId: unknown): Promise<{ orderId: number; userId: number } | Response> {
  const userId = deps.authorize(req);
  if (userId == null) return json({ error: 'unauthorized' }, 401);
  const orderId = Number(rawOrderId);
  if (!Number.isInteger(orderId) || orderId <= 0) return json({ error: 'Not found' }, 404);
  if (!(await deps.orderVisibleTo(orderId, userId))) return json({ error: 'Not found' }, 404);
  return { orderId, userId };
}

export async function handleList(deps: CaptureDeps, req: Request): Promise<Response> {
  try {
    const g = await guard(deps, req, new URL(req.url).searchParams.get('orderId'));
    if (g instanceof Response) return g;
    const rows = await deps.listOpenLinks(g.orderId);
    return json({ links: rows.map((r) => ({ id: r.id, status: r.status, link: deps.decrypt(r.linkEnc) })) });
  } catch { return fail(); }
}

export async function handleCapture(deps: CaptureDeps, req: Request): Promise<Response> {
  try {
    let form: FormData;
    try { form = await req.formData(); } catch { return json({ error: 'Invalid request body' }, 400); }
    const g = await guard(deps, req, form.get('orderId'));
    if (g instanceof Response) return g;
    const linkId = Number(form.get('linkId'));
    const link = Number.isInteger(linkId) ? await deps.findLink(g.orderId, linkId) : null;
    if (!link) return json({ error: 'Not found' }, 404);
    if (link.status === 'captured') return json({ error: 'Already captured' }, 409);

    const str = (k: string) => { const v = form.get(k); return typeof v === 'string' ? v : ''; };
    const merchant = str('merchant').trim();
    const value = Number(str('value'));
    const cardNumber = strip(str('cardNumber'));
    const pin = strip(str('pin')) || null;
    if (!merchant || !cardNumber || !Number.isFinite(value) || value <= 0) return json({ error: 'Missing card fields' }, 400);

    // File type comes from the bytes, never from the client's name or Content-Type.
    const toSave: Array<{ key: string; file: File; mime: string; originalName: string }> = [];
    for (const k of ['pdf', 'barcode']) {
      const f = form.get(k);
      if (f instanceof File && f.size > 0) {
        const bytes = new Uint8Array(await f.arrayBuffer());
        const bad = uploadProblem(bytes);
        if (bad) return json({ error: `${k}: ${bad}` }, 400);
        const sniffed = sniffUpload(bytes)!;
        toSave.push({ key: k, file: new File([bytes], `${k}${sniffed.ext}`, { type: sniffed.mime }), mime: sniffed.mime, originalName: f.name || k });
      }
    }
    const files: Array<{ filename: string; originalName: string; mimeType: string }> = [];
    for (const t of toSave) {
      const filename = await deps.saveFile(g.orderId, t.file);
      files.push({ filename, originalName: t.originalName, mimeType: t.mime });
    }
    const giftCardId = await deps.commitCapture({ orderId: g.orderId, linkId, merchant, value, cardNumber, pin, files });
    return json({ ok: true, giftCardId, files: files.length });
  } catch { return fail(); }
}

export async function handleStatus(deps: CaptureDeps, req: Request): Promise<Response> {
  try {
    let body: { orderId?: unknown; linkId?: unknown; status?: unknown } | null;
    try { body = await req.json(); } catch { return json({ error: 'Invalid request body' }, 400); }
    const g = await guard(deps, req, body?.orderId);
    if (g instanceof Response) return g;
    const linkId = Number(body?.linkId);
    if (body?.status !== 'failed' && body?.status !== 'pending') return json({ error: 'Bad status' }, 400);
    const link = Number.isInteger(linkId) ? await deps.findLink(g.orderId, linkId) : null;
    if (!link) return json({ error: 'Not found' }, 404);
    if (link.status === 'captured') return json({ error: 'Already captured' }, 409);
    await deps.setLinkStatus(g.orderId, linkId, body.status);
    return json({ ok: true });
  } catch { return fail(); }
}
