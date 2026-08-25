'use client';

/**
 * The gift-card OCR review screen (see app/orders/[id]/giftcard-ocr/page.tsx,
 * which gates it behind the feature flag).
 *
 * Two panes because there are two questions, and they have different answers:
 *
 *  - VERIFICATION (top): cards that already have a code. OCR is a cross-check
 *    here. CONFIRMED is quiet, MISMATCH/WRONG_CARD are the flag, and NO_READ /
 *    NOT_APPLICABLE are deliberately NOT flags — 12 of 28 images in the
 *    measured set produced no DB match, and some of those were Costco receipts
 *    rather than cards. Styling them like errors is how a flag gets ignored.
 *
 *  - ENTRY (below): codes read that this order does not have. Editable, opt-in
 *    per code, and never saved without the user pressing the button. Several
 *    codes on one image is the normal case, not an edge case — one image in
 *    the measured set carries two distinct 16-digit codes — so every code gets
 *    its own row rather than there being one input per image.
 *
 * Pre-selection follows inter-variant agreement, which is free confidence
 * information already in the response: both variants read it identically ->
 * pre-selected; they disagree -> shown, not pre-selected, user decides.
 */

import Link from 'next/link';
import { useCallback, useState } from 'react';

type Region = { x: number; y: number; w: number; h: number; variant: string };
type Candidate = { pin: string; agreement: number; variants: string[]; region?: Region | null };

type ImageResult = {
  attachmentId: number;
  originalName: string;
  mimeType: string;
  rotation: number;
  candidates: Candidate[];
  variants: { variant: string; candidates: string[]; n_boxes: number; elapsed_s: number }[];
  receiptMarkers: string[];
  looksLikeReceipt: boolean;
  error?: string;
};

type Verdict = 'CONFIRMED' | 'MISMATCH' | 'WRONG_CARD' | 'NO_READ' | 'NOT_APPLICABLE';

type VerificationResult = {
  card: { id: number | string; label?: string };
  verdict: Verdict;
  reason: string;
  expected: string[];
  matched?: string;
  matchedAgreement?: number;
  foundElsewhere?: { pin: string; owner: string };
  nearest?: { pin: string; distance: number };
  receiptMarkers: string[];
  variants: { variant: string; candidates: string[]; nBoxes: number; elapsedS: number }[];
};

type Suggestion = {
  pin: string;
  agreement: number;
  variants: string[];
  region: Region | null;
  attachmentId: number;
  strong: boolean;
};

type Analysis = {
  order: { id: number; orderNumber: string | null; platform: string; defaultMerchant: string };
  cards: { id: number; merchant: string; value: number; cardNumber: string; pin: string | null }[];
  images: ImageResult[];
  verification: { imageCount: number; cardCount: number; flagged: number; results: VerificationResult[] };
  suggestions: Suggestion[];
  truncated: { total: number; analysed: number } | null;
};

type Row = Suggestion & {
  selected: boolean;
  value: string;
  merchant: string;
  code: string;
  pinField: string;
};

const VERDICT_STYLE: Record<Verdict, { label: string; cls: string }> = {
  CONFIRMED: { label: 'Confirmed', cls: 'bg-green-100 text-green-800 border-green-300' },
  MISMATCH: { label: 'Mismatch', cls: 'bg-red-100 text-red-800 border-red-300' },
  WRONG_CARD: { label: 'Wrong record?', cls: 'bg-amber-100 text-amber-900 border-amber-300' },
  NO_READ: { label: 'No read', cls: 'bg-gray-100 text-gray-600 border-gray-300' },
  NOT_APPLICABLE: { label: 'Not a gift card', cls: 'bg-gray-100 text-gray-600 border-gray-300' },
};

/**
 * Magnified crop of one candidate's region, so verifying a code does not mean
 * opening the file in another tab. Padded by 40% of the region on each axis for
 * context — a bare bounding box around 16 characters is hard to place on a card.
 */
function ZoomInset({ src, region }: { src: string; region: Region }) {
  const padX = Math.min(0.45, region.w * 0.4);
  const padY = Math.min(0.45, region.h * 1.5);
  const x = Math.max(0, region.x - padX);
  const y = Math.max(0, region.y - padY);
  const w = Math.min(1 - x, region.w + padX * 2);
  const h = Math.min(1 - y, region.h + padY * 2);
  // Guard the degenerate full-width/height case, where the position formula
  // divides by zero.
  const bgW = w > 0 ? (1 / w) * 100 : 100;
  const bgH = h > 0 ? (1 / h) * 100 : 100;
  const posX = w < 1 ? (x / (1 - w)) * 100 : 0;
  const posY = h < 1 ? (y / (1 - h)) * 100 : 0;
  return (
    <div
      className="w-full h-24 rounded border border-gray-300 bg-gray-50"
      style={{
        backgroundImage: `url(${src})`,
        backgroundSize: `${bgW}% ${bgH}%`,
        backgroundPosition: `${posX}% ${posY}%`,
        backgroundRepeat: 'no-repeat',
      }}
    />
  );
}

export default function GiftCardOcrReview({ orderId }: { orderId: number }) {
  const [data, setData] = useState<Analysis | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [focus, setFocus] = useState<{ attachmentId: number; region: Region } | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);

  const previewUrl = (attachmentId: number) =>
    `/api/giftcard-ocr/orders/${orderId}/preview/${attachmentId}`;

  const analyse = useCallback(async () => {
    setLoading(true);
    setError(null);
    setSaved(null);
    try {
      const res = await fetch(`/api/giftcard-ocr/orders/${orderId}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
      const analysis = body as Analysis;
      setData(analysis);
      setRows(analysis.suggestions.map(s => ({
        ...s,
        // Agreement across both variants is the strong signal; only that gets
        // a tick by default. Anything the variants disagreed on is presented
        // unselected so the user has to make the call.
        selected: s.strong,
        code: s.pin,
        pinField: '',
        merchant: analysis.order.defaultMerchant || '',
        value: '',
      })));
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [orderId]);

  // Note the absence of a mount effect here: nothing runs until the user
  // presses "Read photos". OCR is roughly a minute of CPU per image on a
  // shared box, and this screen must never do work that was not asked for.

  function update(i: number, patch: Partial<Row>) {
    setRows(prev => prev.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  }

  async function save() {
    const chosen = rows.filter(r => r.selected);
    if (!chosen.length) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/giftcard-ocr/orders/${orderId}/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          codes: chosen.map(r => ({
            cardNumber: r.code,
            pin: r.pinField || null,
            merchant: r.merchant,
            value: Number(r.value),
            // What OCR proposed, so the saved row can record whether the user
            // accepted it unchanged or corrected it. Never used as the code.
            suggested: r.pin,
            agreement: r.agreement,
          })),
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
      const skipped = (body.skipped ?? []) as { cardNumber: string; reason: string }[];
      setSaved(
        `Saved ${body.created?.length ?? 0} card(s)`
        + (skipped.length ? ` — skipped ${skipped.length}: ${skipped.map(s => `${s.cardNumber} (${s.reason})`).join(', ')}` : ''),
      );
      await analyse();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  const selectedCount = rows.filter(r => r.selected).length;
  const incomplete = rows.some(r => r.selected && (!r.code.trim() || !r.merchant.trim() || !(Number(r.value) > 0)));

  return (
    <div className="max-w-6xl mx-auto p-4 space-y-6">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold">Gift-card OCR</h1>
          <p className="text-sm text-gray-600">
            Order <Link href={`/orders/${orderId}`} className="underline">#{orderId}</Link>
            {data?.order.orderNumber ? ` · ${data.order.orderNumber}` : ''}
          </p>
        </div>
        <button
          onClick={analyse}
          disabled={loading}
          className="px-4 py-2 rounded bg-blue-600 text-white disabled:opacity-50"
        >
          {loading ? 'Reading photos…' : data ? 'Re-read photos' : 'Read photos'}
        </button>
      </div>

      <p className="text-xs text-gray-500 border-l-2 border-gray-300 pl-3">
        OCR never saves a code on its own. Below is what it read; nothing is written
        until you press Save, and the stored code is whatever is in the box at that
        moment — not what OCR suggested.
      </p>

      {error && <div className="p-3 rounded bg-red-50 text-red-800 text-sm">{error}</div>}
      {saved && <div className="p-3 rounded bg-green-50 text-green-800 text-sm">{saved}</div>}

      {!data && !loading && (
        <p className="text-sm text-gray-500">Nothing read yet.</p>
      )}

      {data?.truncated && (
        <div className="p-3 rounded bg-amber-50 text-amber-900 text-sm">
          This order has {data.truncated.total} photos; only the first {data.truncated.analysed} were read.
        </div>
      )}

      {data && (
        <>
          {/* ---- flow A: cross-check entered codes ------------------------ */}
          <section className="space-y-2">
            <h2 className="text-lg font-medium">
              Entered codes ({data.verification.cardCount})
              {data.verification.flagged > 0 && (
                <span className="ml-2 text-sm text-red-700">{data.verification.flagged} to look at</span>
              )}
            </h2>
            {!data.verification.results.length && (
              <p className="text-sm text-gray-500">No cards on this order yet.</p>
            )}
            <div className="space-y-2">
              {data.verification.results.map(r => {
                const style = VERDICT_STYLE[r.verdict];
                return (
                  <details key={String(r.card.id)} className={`rounded border p-3 text-sm ${style.cls}`}>
                    <summary className="cursor-pointer flex items-center gap-3 flex-wrap">
                      <span className="font-medium">{style.label}</span>
                      <span className="font-mono">{r.expected[0] ?? '—'}</span>
                      <span className="opacity-80">{r.card.label}</span>
                      <span className="opacity-70">{r.reason}</span>
                    </summary>
                    <div className="mt-3 space-y-1 text-xs opacity-90">
                      {r.foundElsewhere && (
                        <p>Read <span className="font-mono">{r.foundElsewhere.pin}</span>, which belongs to {r.foundElsewhere.owner}.</p>
                      )}
                      {r.nearest && (
                        <p>
                          Closest read: <span className="font-mono">{r.nearest.pin}</span>{' '}
                          ({r.nearest.distance} character{r.nearest.distance === 1 ? '' : 's'} different).
                          {' '}Shown for context only — it did not affect the verdict.
                        </p>
                      )}
                      {r.receiptMarkers.length > 0 && (
                        <p>Receipt wording found: {r.receiptMarkers.join(', ')}</p>
                      )}
                      <div>
                        <p className="font-medium mt-2">What each variant read</p>
                        {r.variants.map((v, i) => (
                          <p key={`${v.variant}-${i}`} className="font-mono">
                            {v.variant}: {v.candidates.length ? v.candidates.join(', ') : '(nothing code-shaped)'}
                            {' '}· {v.nBoxes} boxes · {v.elapsedS}s
                          </p>
                        ))}
                      </div>
                    </div>
                  </details>
                );
              })}
            </div>
          </section>

          {/* ---- the photos ---------------------------------------------- */}
          <section className="space-y-4">
            <h2 className="text-lg font-medium">Photos ({data.images.length})</h2>
            {!data.images.length && <p className="text-sm text-gray-500">No image attachments on this order.</p>}
            {data.images.map(img => (
              <div key={img.attachmentId} className="border rounded p-3 space-y-2">
                <div className="flex items-baseline justify-between gap-3 flex-wrap">
                  <span className="font-medium text-sm">{img.originalName}</span>
                  <span className="text-xs text-gray-500">
                    {img.variants.map(v => `${v.variant} ${v.elapsed_s}s`).join(' · ')}
                  </span>
                </div>

                {img.error && <p className="text-sm text-red-700">Could not read: {img.error}</p>}

                {/* Not an error state and not an empty form — some uploads are
                    genuinely receipts, and saying so plainly is the point. */}
                {img.looksLikeReceipt && !img.candidates.length && (
                  <p className="text-sm text-gray-600 bg-gray-50 rounded p-2">
                    This looks like a receipt rather than a gift card
                    ({img.receiptMarkers.join(', ')}). Nothing to enter here.
                  </p>
                )}
                {!img.looksLikeReceipt && !img.candidates.length && !img.error && (
                  <p className="text-sm text-gray-600 bg-gray-50 rounded p-2">
                    Nothing code-shaped was found in this photo.
                  </p>
                )}

                <div className="relative inline-block max-w-full">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={previewUrl(img.attachmentId)}
                    alt={img.originalName}
                    className="max-w-full rounded"
                  />
                  {img.candidates.map(c => c.region && (
                    <button
                      key={c.pin}
                      type="button"
                      onClick={() => setFocus({ attachmentId: img.attachmentId, region: c.region! })}
                      title={c.pin}
                      className="absolute border-2 border-yellow-400 bg-yellow-300/20 hover:bg-yellow-300/40"
                      style={{
                        left: `${c.region.x * 100}%`,
                        top: `${c.region.y * 100}%`,
                        width: `${c.region.w * 100}%`,
                        height: `${c.region.h * 100}%`,
                      }}
                    />
                  ))}
                </div>

                {focus?.attachmentId === img.attachmentId && (
                  <div className="space-y-1">
                    <p className="text-xs text-gray-500">Zoom</p>
                    <ZoomInset src={previewUrl(img.attachmentId)} region={focus.region} />
                  </div>
                )}
              </div>
            ))}
          </section>

          {/* ---- flow B: assisted entry ---------------------------------- */}
          <section className="space-y-2">
            <h2 className="text-lg font-medium">New codes read ({rows.length})</h2>
            {!rows.length && (
              <p className="text-sm text-gray-500">
                Nothing read that is not already on this order.
              </p>
            )}
            {rows.map((r, i) => (
              <div key={`${r.attachmentId}-${r.pin}`} className="border rounded p-3 space-y-2">
                <div className="flex items-start gap-3 flex-wrap">
                  <input
                    type="checkbox"
                    checked={r.selected}
                    onChange={e => update(i, { selected: e.target.checked })}
                    className="mt-2"
                    aria-label={`Save ${r.pin}`}
                  />
                  <div className="flex-1 min-w-[16rem] space-y-1">
                    <input
                      value={r.code}
                      onChange={e => update(i, { code: e.target.value })}
                      className="w-full border rounded px-2 py-1 font-mono"
                      aria-label="Card number"
                    />
                    <p className="text-xs text-gray-500">
                      {r.strong
                        ? `Both variants read this identically (${r.variants.join(', ')})`
                        : `Only ${r.variants.join(', ')} read this — check it before saving`}
                      {r.code !== r.pin && ' · edited'}
                    </p>
                  </div>
                  <input
                    value={r.pinField}
                    onChange={e => update(i, { pinField: e.target.value })}
                    placeholder="PIN (optional)"
                    className="border rounded px-2 py-1 font-mono w-32"
                    aria-label="PIN"
                  />
                  <input
                    value={r.merchant}
                    onChange={e => update(i, { merchant: e.target.value })}
                    placeholder="Merchant"
                    className="border rounded px-2 py-1 w-36"
                    aria-label="Merchant"
                  />
                  <input
                    value={r.value}
                    onChange={e => update(i, { value: e.target.value })}
                    placeholder="Value"
                    inputMode="decimal"
                    className="border rounded px-2 py-1 w-24"
                    aria-label="Value"
                  />
                  <button
                    type="button"
                    onClick={() => update(i, { selected: false })}
                    className="text-xs text-gray-500 underline mt-2"
                  >
                    discard
                  </button>
                </div>
                {r.region && (
                  <ZoomInset src={previewUrl(r.attachmentId)} region={r.region} />
                )}
              </div>
            ))}

            {rows.length > 0 && (
              <div className="flex items-center gap-3 pt-2">
                <button
                  onClick={save}
                  disabled={saving || !selectedCount || incomplete}
                  className="px-4 py-2 rounded bg-green-600 text-white disabled:opacity-50"
                >
                  {saving ? 'Saving…' : `Save ${selectedCount} code${selectedCount === 1 ? '' : 's'} to order`}
                </button>
                {incomplete && (
                  <span className="text-sm text-amber-800">
                    Every selected code needs a card number, a merchant and a value.
                  </span>
                )}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
