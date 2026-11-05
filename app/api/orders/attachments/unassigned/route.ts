import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { resolveExtensionUserId } from '@/lib/extensionAuth';
import { NextRequest } from 'next/server';
import { readGiftCodes } from '@/lib/giftCodeParse';
import { photoOcrQueueStatus } from '@/lib/photoOcrRun';

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
        select: { status: true, kind: true, strength: true, suggestedOrderId: true, giftCardId: true, alternatives: true, reason: true, error: true, texts: true, boxes: true, draft: true },
      },
    },
  });
  // Gift codes read off each photo, minus any already on the matched order.
    const orderIds = [...new Set(attachments.map(a => a.photoOcr?.suggestedOrderId).filter((x): x is number => x != null))];
  const [cards, matchOrders] = orderIds.length
    ? await Promise.all([
      prisma.giftCard.findMany({ where: { orderId: { in: orderIds }, order: { userId: uid } }, select: { id: true, orderId: true, cardNumber: true, merchant: true, value: true } }),
      prisma.order.findMany({ where: { id: { in: orderIds }, userId: uid }, select: { id: true, orderNumber: true, locked: true, platform: true, orderDate: true, cost: true, itemDescription: true, buyer: { select: { name: true } }, card: { select: { name: true, last4: true } } } }),
    ])
    : [[], []];
  const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const out = attachments.map(a => {
    if (!a.photoOcr) return a;
    const { texts, boxes: rawBoxes, draft: rawDraft, ...ocr } = a.photoOcr;
    let draft: unknown = null;
    try { draft = rawDraft ? JSON.parse(rawDraft) : null; } catch { /* unreadable row */ }
    let lines: string[] = [];
    try { lines = texts ? (JSON.parse(texts) as string[]) : []; } catch { /* unreadable row */ }
    const onOrder = cards.filter(c => c.orderId === ocr.suggestedOrderId);
    const have = new Set(onOrder.map(c => norm(c.cardNumber)));
    const giftCodes = readGiftCodes(lines).filter(g => !have.has(g.code));
    // Prefill value/merchant from cards already on the order, when there are any.
    const like = onOrder[0];
    // What the match rests on: the identifier on file, and the OCR lines it
    // was read from, so the user can check it against the photo.
    const ord = matchOrders.find(o => o.id === ocr.suggestedOrderId);
    const card = ocr.giftCardId != null ? onOrder.find(c => c.id === ocr.giftCardId) : undefined;
    // A photo showing several of the order's cards matches with no single card
    // (giftCardId null), so look for every card on the order.
    const cardKeys = card ? [card.cardNumber] : onOrder.map(c => c.cardNumber);
    const keys = [...cardKeys, ord?.orderNumber].filter((k): k is string => !!k).map(norm).filter(k => k.length >= 6);
    const matchedLines = keys.length ? lines.filter(l => keys.some(k => norm(l).includes(k) || (norm(l).length >= 8 && k.includes(norm(l))))) : [];
    let boxes: { t: string; b: [number, number, number, number] }[] = [];
    try { boxes = rawBoxes ? JSON.parse(rawBoxes) : []; } catch { /* unreadable row */ }
    // Where on the photo each matched line was read, for a cropped preview.
    const snips = matchedLines.map(l => boxes.find(b => b.t === l)?.b).filter((b): b is [number, number, number, number] => !!b).slice(0, 3);
    // A drafted order: crop the lines its store, amount and order number came from.
    const d = draft as { platform?: string; cost?: string; orderNumber?: string | null } | null;
    const draftKeys = d ? [d.platform, d.cost, d.orderNumber].filter((k): k is string => !!k).map(norm).filter(k => k.length >= 3) : [];
    const draftSnips = draftKeys
      .map(k => boxes.find(b => norm(b.t).includes(k))?.b)
      .filter((b, i, all): b is [number, number, number, number] => !!b && all.findIndex(x => x === b) === i)
      .slice(0, 3);
    const evidence = ocr.suggestedOrderId == null ? null : {
      cardNumber: card?.cardNumber ?? null,
      orderNumber: ord?.orderNumber ?? null,
      matchedLines,
      snips,
      locked: !!ord?.locked,
      order: ord ? {
        id: ord.id,
        orderNumber: ord.orderNumber,
        platform: ord.platform,
        orderDate: ord.orderDate,
        cost: ord.cost,
        itemDescription: ord.itemDescription,
        group: ord.buyer?.name ?? null,
        paidWith: ord.card ? `${ord.card.name}${ord.card.last4 ? ` ...${ord.card.last4}` : ''}` : null,
        giftCards: onOrder.map(c => ({ id: c.id, cardNumber: c.cardNumber, value: c.value, merchant: c.merchant })),
      } : null,
    };
    return { ...a, photoOcr: { ...ocr, giftCodes, cardDefaults: like ? { merchant: like.merchant, value: like.value } : null, draft, draftSnips, evidence, lines } };
  });
  return Response.json({ attachments: out, ocrQueue: photoOcrQueueStatus() });
}
