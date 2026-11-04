import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { resolveExtensionUserId } from '@/lib/extensionAuth';
import { NextRequest } from 'next/server';
import { readGiftCodes } from '@/lib/giftCodeParse';

// Lists photos uploaded via bulk upload that haven't been sorted onto an
// order yet -- the queue /orders/sort-assign works through -- with what OCR
// matched each one to, if it has been scanned.
export async function GET(req: NextRequest) {
  const sessionUid = await getSessionUserId();
  const uid = resolveExtensionUserId(req, sessionUid);
  if (uid == null) return Response.json({ error: 'not authenticated' }, { status: 401 });

  const attachments = await prisma.orderAttachment.findMany({
    where: { orderId: null, userId: uid },
    orderBy: { createdAt: 'asc' },
    include: {
      uploadToken: { select: { name: true } },
      photoOcr: {
        select: { status: true, kind: true, strength: true, suggestedOrderId: true, giftCardId: true, alternatives: true, reason: true, error: true, texts: true, draft: true },
      },
    },
  });
  // Gift codes read off each photo, minus any already on the matched order.
  // The OCR lines themselves stay server-side.
  const orderIds = [...new Set(attachments.map(a => a.photoOcr?.suggestedOrderId).filter((x): x is number => x != null))];
  const cards = orderIds.length
    ? await prisma.giftCard.findMany({ where: { orderId: { in: orderIds }, order: { userId: uid } }, select: { orderId: true, cardNumber: true, merchant: true, value: true } })
    : [];
  const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const out = attachments.map(a => {
    if (!a.photoOcr) return a;
    const { texts, draft: rawDraft, ...ocr } = a.photoOcr;
    let draft: unknown = null;
    try { draft = rawDraft ? JSON.parse(rawDraft) : null; } catch { /* unreadable row */ }
    let lines: string[] = [];
    try { lines = texts ? (JSON.parse(texts) as string[]) : []; } catch { /* unreadable row */ }
    const onOrder = cards.filter(c => c.orderId === ocr.suggestedOrderId);
    const have = new Set(onOrder.map(c => norm(c.cardNumber)));
    const giftCodes = readGiftCodes(lines).filter(g => !have.has(g.code));
    // Prefill value/merchant from cards already on the order, when there are any.
    const like = onOrder[0];
    return { ...a, photoOcr: { ...ocr, giftCodes, cardDefaults: like ? { merchant: like.merchant, value: like.value } : null, draft } };
  });
  return Response.json({ attachments: out });
}
