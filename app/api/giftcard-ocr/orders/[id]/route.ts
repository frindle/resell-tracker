/**
 * OCR every photo on an order and report what it means for that order's cards.
 *
 * This one endpoint feeds both flows, because they are the same read with two
 * different questions asked of it:
 *   A. cards that already have a code  -> `verification` (confirm / flag)
 *   B. codes read that no card has yet -> `suggestions` (assisted entry)
 *
 * DORMANT: 404s unless GIFTCARD_OCR_ENABLED === 'true'. Read-only — this route
 * cannot write, and the write path (apply/) only ever stores values a human
 * submitted.
 */

import { NextRequest } from 'next/server';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import {
  giftCardOcrGate,
  readGiftCardImage,
  rotateRegion,
  type GiftCardOcrResult,
} from '@/lib/giftCardOcr';
import {
  normalizeCode,
  receiptMarkers,
  verifyOrderCards,
  type ExpectedCard,
} from '@/lib/giftCardOcrVerify';
import { orderCardDefaults, suggestionValue } from '@/lib/giftCardDefaults';

const FILES_DIR = '/data/files';

// Each image costs seconds of CPU across the variant ensemble, and orders with
// a bulk photo dump exist. Cap it and say so rather than letting one request
// occupy the service for minutes.
const MAX_IMAGES = 12;

type ImageRead = {
  attachmentId: number;
  originalName: string;
  mimeType: string;
  rotation: number;
  ocr: GiftCardOcrResult;
  receiptMarkers: string[];
  error?: string;
};

// One photo's read, used by the full read and the single-photo re-read alike.
// A failed read is an entry with an error, not a thrown error, so one bad
// photo does not lose the others.
async function readImage(
  orderId: number,
  att: { id: number; filename: string; originalName: string; mimeType: string; rotation: number },
): Promise<ImageRead> {
  try {
    const buf = await readFile(join(FILES_DIR, String(orderId), att.filename));
    const ocr = await readGiftCardImage(new Uint8Array(buf), {
      filename: att.originalName,
      contentType: att.mimeType,
    });
    // Regions come back relative to the OCR-orientation image; the UI shows
    // the photo at the user's chosen rotation, so move them with it.
    const rotated: GiftCardOcrResult = {
      ...ocr,
      candidates: ocr.candidates.map(c => ({
        ...c,
        region: c.region ? rotateRegion(c.region, att.rotation) : c.region,
      })),
    };
    return {
      attachmentId: att.id,
      originalName: att.originalName,
      mimeType: att.mimeType,
      rotation: att.rotation,
      ocr: rotated,
      receiptMarkers: receiptMarkers(ocr.texts ?? []),
    };
  } catch (e) {
    return {
      attachmentId: att.id,
      originalName: att.originalName,
      mimeType: att.mimeType,
      rotation: att.rotation,
      ocr: {
        ok: true, model_set: 'unknown', long_edge: 0, elapsed_s: 0,
        variants: [], candidates: [], texts: [], consensus: [],
      },
      receiptMarkers: [],
      error: String(e),
    };
  }
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = giftCardOcrGate();
  if (gate) return gate;

  try {
    const userId = await getSessionUserId();
    if (userId == null) return Response.json({ error: 'not authenticated' }, { status: 401 });

    const { id } = await params;
    const orderId = parseInt(id);
    const order = await prisma.order.findFirst({
      where: { id: orderId, userId },
      select: { id: true, orderNumber: true, platform: true, itemDescription: true },
    });
    if (!order) return Response.json({ error: 'Not found' }, { status: 404 });

    const cards = await prisma.giftCard.findMany({
      where: { orderId },
      orderBy: { createdAt: 'asc' },
    });

    const attachments = (await prisma.orderAttachment.findMany({
      where: { orderId },
      orderBy: { createdAt: 'asc' },
    })).filter(a => a.mimeType.startsWith('image/'));

    // ?attachment=<id> reads that one photo only (a re-read of a single photo).
    const only = req.nextUrl.searchParams.get('attachment');
    const one = only == null ? null : attachments.find(a => String(a.id) === only);
    if (only != null && !one) return Response.json({ error: 'Not found' }, { status: 404 });
    const selected = one ? [one] : attachments.slice(0, MAX_IMAGES);

    // Codes belonging to OTHER orders, so a read can be identified as "this
    // photo is on the wrong record" rather than reported as a typo.
    const otherCards = await prisma.giftCard.findMany({
      where: { orderId: { not: orderId }, order: { userId } },
      select: { id: true, orderId: true, merchant: true, cardNumber: true, pin: true },
    });
    const knownCodes = new Map<string, string>();
    for (const c of otherCards) {
      const owner = `order #${c.orderId} (${c.merchant})`;
      for (const code of [c.cardNumber, c.pin]) {
        const n = normalizeCode(code);
        if (n) knownCodes.set(n, owner);
      }
    }

    const images: ImageRead[] = [];
    for (const att of selected) images.push(await readImage(orderId, att));

    // ---- flow A: cross-check the codes already entered --------------------
    const expected: ExpectedCard[] = cards.map(c => ({
      id: c.id,
      cardNumber: c.cardNumber,
      pin: c.pin,
      label: `${c.merchant} $${c.value}`,
    }));
    const verification = verifyOrderCards(
      expected,
      images.map(i => ({ id: i.attachmentId, name: i.originalName, ocr: i.ocr })),
      knownCodes,
    );

    // ---- flow B: codes read that this order does not already have ---------
    const entered = new Set(
      cards.flatMap(c => [normalizeCode(c.cardNumber), normalizeCode(c.pin)]).filter(Boolean),
    );
    // Brand and face value to start each row with (a person checks them before saving).
    const defaults = orderCardDefaults(order.itemDescription, cards, [...new Set(otherCards.map(c => c.merchant))]);
    // A pin read on two photos is suggested once, from the first.
    const seen = new Set<string>();
    const suggestions = images.flatMap(img =>
      img.ocr.candidates
        .filter(c => !entered.has(c.pin))
        .filter(c => (seen.has(c.pin) ? false : (seen.add(c.pin), true)))
        .map(c => ({
          pin: c.pin,
          agreement: c.agreement,
          variants: c.variants,
          region: c.region ?? null,
          attachmentId: img.attachmentId,
          // Both variants read it identically — the strong signal, and the
          // only case the UI pre-selects. Disagreement means the user chooses.
          strong: c.agreement >= (img.ocr.variants.length || 2),
          ...suggestionValue(img.ocr.texts ?? [], defaults),
        })),
    );

    return Response.json({
      order: {
        id: order.id,
        orderNumber: order.orderNumber,
        platform: order.platform,
        // The gift-card BRAND, which is not the order's platform (an Amazon
        // order carries DoorDash cards): a brand already on this order's cards,
        // else the one brand a gift card item description names ("$50
        // DoorDash GC"), else blank rather than a plausible-looking guess.
        defaultMerchant: defaults.merchant,
        merchantFrom: defaults.merchantFrom,
      },
      cards: cards.map(c => ({
        id: c.id, merchant: c.merchant, value: c.value,
        cardNumber: c.cardNumber, pin: c.pin,
      })),
      images: images.map(i => ({
        attachmentId: i.attachmentId,
        originalName: i.originalName,
        mimeType: i.mimeType,
        rotation: i.rotation,
        candidates: i.ocr.candidates,
        variants: i.ocr.variants.map(v => ({
          variant: v.variant, candidates: v.candidates, n_boxes: v.n_boxes, elapsed_s: v.elapsed_s,
        })),
        receiptMarkers: i.receiptMarkers,
        // Two independent markers, matching looksLikeReceipt() — one is too
        // easy to hit on a real card.
        looksLikeReceipt: i.receiptMarkers.length >= 2,
        error: i.error,
      })),
      verification,
      suggestions,
      truncated: !one && attachments.length > selected.length
        ? { total: attachments.length, analysed: selected.length }
        : null,
    });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 502 });
  }
}
