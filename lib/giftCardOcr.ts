/**
 * Client for the gift-card OCR sidecar (`giftcard-ocr/`).
 *
 * DORMANT ON PURPOSE. Nothing in the app calls this. It exists so the capability
 * is deployable and exercisable while the user flow is still undecided — see
 * giftcard-ocr/README.md for what that decision involves.
 *
 * Two independent things have to be true before a single byte leaves this
 * process:
 *   1. `GIFTCARD_OCR_ENABLED` is exactly "true" (unset/anything else = off), and
 *   2. some caller actually invokes one of these functions — no timer, no
 *      route, no sync loop does.
 *
 * With the flag unset, `readGiftCardImage` throws before constructing a request,
 * so the service does not need to exist and no network call is attempted.
 */

/** Thrown when OCR is invoked while the feature flag is off. */
export class GiftCardOcrDisabledError extends Error {
  constructor() {
    super('Gift-card OCR is disabled (set GIFTCARD_OCR_ENABLED=true to enable)');
    this.name = 'GiftCardOcrDisabledError';
  }
}

export type GiftCardOcrVariantResult = {
  variant: string;
  elapsed_s: number;
  n_boxes: number;
  candidates: string[];
  /** Every string the recogniser read, for auditing a flag after the fact. */
  texts: string[];
};

/**
 * Where a candidate was found, as fractions (0..1) of the image. The service
 * returns fractions rather than pixels because the UI renders the original
 * upload, which is a different size from whatever the variant rendered to.
 */
export type GiftCardOcrRegion = {
  x: number;
  y: number;
  w: number;
  h: number;
  variant: string;
};

export type GiftCardOcrCandidate = {
  /** Normalised candidate code (A-Z0-9 only). */
  pin: string;
  /** Which preprocessing variants produced it. */
  variants: string[];
  /** variants.length — how many variants agreed. */
  agreement: number;
  region?: GiftCardOcrRegion | null;
};

export type GiftCardOcrResult = {
  ok: true;
  model_set: string;
  long_edge: number;
  elapsed_s: number;
  variants: GiftCardOcrVariantResult[];
  candidates: GiftCardOcrCandidate[];
  /** Every recognised string across every variant. */
  texts: string[];
  /** Candidates every variant produced — the high-confidence subset. */
  consensus: string[];
  windows?: string[];
};

export type GiftCardOcrHealth = {
  ok: boolean;
  service: string;
  model_set: string;
  long_edge: number;
  variants: string[];
  model_loaded: boolean;
  heif_support: boolean;
  max_bytes: number;
};

/**
 * The single gate. Deliberately an exact string compare rather than anything
 * truthy, so "1", "yes", "false" and a stray empty string all leave it off.
 */
export function isGiftCardOcrEnabled(): boolean {
  return process.env.GIFTCARD_OCR_ENABLED === 'true';
}

/**
 * Gate for every OCR route. Returns a 404 (not a 403) when the flag is off, so
 * a deployment with OCR disabled is indistinguishable from one where these
 * routes were never built — nothing to probe, nothing to discover.
 */
export function giftCardOcrGate(): Response | null {
  if (!isGiftCardOcrEnabled()) return new Response('Not found', { status: 404 });
  return null;
}

/**
 * Re-map a candidate region for a display rotation of 0/90/180/270 degrees
 * clockwise. OCR runs on the EXIF-normalised image; OrderAttachment carries an
 * extra user-chosen `rotation` for display, and without this the highlight box
 * would land on the wrong part of a sideways photo.
 */
export function rotateRegion(r: GiftCardOcrRegion, rotation: number): GiftCardOcrRegion {
  const deg = ((rotation % 360) + 360) % 360;
  if (deg === 90) return { ...r, x: 1 - r.y - r.h, y: r.x, w: r.h, h: r.w };
  if (deg === 180) return { ...r, x: 1 - r.x - r.w, y: 1 - r.y - r.h };
  if (deg === 270) return { ...r, x: r.y, y: 1 - r.x - r.w, w: r.h, h: r.w };
  return r;
}

/** Base URL of the OCR container. Only meaningful when the flag is on. */
export function giftCardOcrUrl(): string {
  return (process.env.GIFTCARD_OCR_URL || 'http://10.0.12.41:8080').replace(/\/+$/, '');
}

function ocrHeaders(): Record<string, string> {
  const secret = process.env.GIFTCARD_OCR_SECRET;
  return secret ? { 'X-OCR-Secret': secret } : {};
}

/**
 * OCR one gift-card image.
 *
 * Returns every candidate with the variants that produced it rather than a
 * single answer: the ensemble's value is that agreement across variants is the
 * confidence signal, and collapsing it here would throw that away before any
 * caller could use it.
 *
 * @throws GiftCardOcrDisabledError when the feature flag is off.
 */
export async function readGiftCardImage(
  image: Uint8Array | ArrayBuffer | Blob,
  opts: {
    filename?: string;
    contentType?: string;
    /** Override the service's configured variant list. */
    variants?: string[];
    /** Also return every PIN-length window of the page text (noisy fallback). */
    includeWindows?: boolean;
    timeoutMs?: number;
  } = {},
): Promise<GiftCardOcrResult> {
  if (!isGiftCardOcrEnabled()) throw new GiftCardOcrDisabledError();

  const params = new URLSearchParams();
  if (opts.variants?.length) params.set('variants', opts.variants.join(','));
  if (opts.includeWindows) params.set('include_windows', 'true');
  const qs = params.toString();

  const blob = image instanceof Blob
    ? image
    : new Blob([image as BlobPart], { type: opts.contentType || 'application/octet-stream' });
  const form = new FormData();
  form.append('file', blob, opts.filename || 'card.jpg');

  // OCR is CPU-bound and runs several preprocessing variants per image; a
  // default fetch timeout would cut a legitimate read short.
  const res = await fetch(`${giftCardOcrUrl()}/ocr${qs ? `?${qs}` : ''}`, {
    method: 'POST',
    headers: ocrHeaders(),
    body: form,
    signal: AbortSignal.timeout(opts.timeoutMs ?? 180_000),
  });

  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`OCR service returned non-JSON (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
  if (!res.ok || !(body as { ok?: boolean }).ok) {
    const err = (body as { error?: string }).error || `HTTP ${res.status}`;
    throw new Error(`OCR service error: ${err}`);
  }
  return body as GiftCardOcrResult;
}

/** Liveness/config probe for the OCR container. Same flag gate. */
export async function giftCardOcrHealth(timeoutMs = 10_000): Promise<GiftCardOcrHealth> {
  if (!isGiftCardOcrEnabled()) throw new GiftCardOcrDisabledError();
  const res = await fetch(`${giftCardOcrUrl()}/health`, {
    headers: ocrHeaders(),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`OCR service health check failed: HTTP ${res.status}`);
  return (await res.json()) as GiftCardOcrHealth;
}
