/**
 * Flow B write path: persist codes a human accepted on the review screen.
 *
 * The invariant this route exists to enforce is that **OCR never writes a code
 * autonomously**. Nothing here reads from the OCR service; it only accepts a
 * body the user submitted from the review screen, exactly as they left it after
 * correcting it. The `suggested` field is compared against the submitted value
 * purely to record whether they changed it — it is never itself stored as the
 * code.
 *
 * DORMANT: 404s unless GIFTCARD_OCR_ENABLED === 'true'.
 */

import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { requireOrderUnlocked } from '@/lib/orderLock';
import { giftCardOcrGate } from '@/lib/giftCardOcr';
import { normalizeCode } from '@/lib/giftCardOcrVerify';

// Matches the whitespace stripping the ordinary gift-card route applies, so a
// code entered here and the same code entered on the form land identically.
function stripWs(s: string) {
  return s.replace(/\s+/g, '');
}

type AcceptedCode = {
  /** What the user is actually saving. Authoritative. */
  cardNumber: string;
  pin?: string | null;
  merchant: string;
  value: number;
  /** What OCR proposed, if anything — used only to derive provenance. */
  suggested?: string | null;
  /** Variants that agreed on the suggestion at the time it was shown. */
  agreement?: number | null;
};

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = giftCardOcrGate();
  if (gate) return gate;

  try {
    const userId = await getSessionUserId();
    if (userId == null) return Response.json({ error: 'not authenticated' }, { status: 401 });

    const { id } = await params;
    const orderId = parseInt(id);

    const lockErr = await requireOrderUnlocked(orderId, userId);
    if (lockErr) return lockErr;

    const order = await prisma.order.findFirst({ where: { id: orderId, userId }, select: { id: true } });
    if (!order) return Response.json({ error: 'Not found' }, { status: 404 });

    const body = await req.json() as { codes?: AcceptedCode[] };
    const codes = Array.isArray(body.codes) ? body.codes : [];
    if (!codes.length) return Response.json({ error: 'no codes submitted' }, { status: 400 });

    const existing = await prisma.giftCard.findMany({ where: { orderId }, select: { cardNumber: true } });
    const already = new Set(existing.map(c => normalizeCode(c.cardNumber)));

    const created = [];
    const skipped = [];
    for (const c of codes) {
      const cardNumber = stripWs(String(c.cardNumber ?? ''));
      if (!cardNumber) {
        skipped.push({ cardNumber: c.cardNumber, reason: 'empty' });
        continue;
      }
      if (already.has(normalizeCode(cardNumber))) {
        skipped.push({ cardNumber, reason: 'already on this order' });
        continue;
      }
      if (!c.merchant?.trim() || !(Number(c.value) > 0)) {
        skipped.push({ cardNumber, reason: 'merchant and a positive value are required' });
        continue;
      }

      // ocr_confirmed vs ocr_corrected is decided here, from what the user
      // submitted against what was suggested — the whole point of recording it
      // is to be able to separate "accepted unchanged" from "fixed by hand"
      // later, which is the only real-world accuracy signal this feature can
      // produce. No suggestion at all means they typed it: plain manual.
      const suggested = c.suggested ? normalizeCode(c.suggested) : '';
      const codeSource = !suggested
        ? 'manual'
        : suggested === normalizeCode(cardNumber) ? 'ocr_confirmed' : 'ocr_corrected';

      const card = await prisma.giftCard.create({
        data: {
          orderId,
          merchant: c.merchant.trim(),
          value: Number(c.value),
          cardNumber,
          pin: c.pin ? stripWs(String(c.pin)) || null : null,
          codeSource,
          codeOcrAgreement: suggested ? (c.agreement ?? null) : null,
        },
      });
      created.push(card);
      already.add(normalizeCode(cardNumber));
    }

    return Response.json({ ok: true, created, skipped });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
