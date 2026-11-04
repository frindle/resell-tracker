import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { resolveExtensionUserId } from '@/lib/extensionAuth';
import { prefillFromPhoto } from '@/lib/photoPrefill';
import { loadDraftCtx } from '@/lib/photoDraftCtx';

// New Order form values guessed from what OCR read off an unsorted photo
// (lib/photoPrefill.ts). Used when creating an order from a photo that
// matched nothing.

function parseJson<T>(s: string | null | undefined, fallback: T): T {
  try { return s ? JSON.parse(s) as T : fallback; } catch { return fallback; }
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ attachmentId: string }> }) {
  const uid = resolveExtensionUserId(req, await getSessionUserId());
  if (uid == null) return Response.json({ error: 'not authenticated' }, { status: 401 });

  const { attachmentId } = await params;
  const att = await prisma.orderAttachment.findFirst({
    where: { id: parseInt(attachmentId), orderId: null, userId: uid },
    include: { photoOcr: true },
  });
  if (!att) return Response.json({ error: 'not found' }, { status: 404 });
  const ocr = att.photoOcr;
  if (!ocr || ocr.status !== 'done') return Response.json({ status: ocr?.status ?? 'unread', prefill: {} });

  const ctx = await loadDraftCtx(uid);
  const prefill = prefillFromPhoto(
    {
      kind: ocr.kind, texts: parseJson<string[]>(ocr.texts, []), candidates: parseJson<string[]>(ocr.candidates, []),
      capturedAt: ocr.capturedAt ?? att.createdAt,
    },
    ctx,
  );
  return Response.json({ status: 'done', kind: ocr.kind, prefill });
}
