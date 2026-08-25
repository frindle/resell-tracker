/**
 * Direct passthrough to the gift-card OCR service — the "can I exercise this?"
 * endpoint. No database, no order, no card: an image goes in and candidates
 * come out, which is what makes the container testable on its own.
 *
 * DORMANT: `giftCardOcrGate()` 404s the whole route unless
 * GIFTCARD_OCR_ENABLED === 'true'. Nothing in the app links here.
 *
 *   curl -H "Cookie: resell_uid=1" http://<app>:3000/api/giftcard-ocr
 *   curl -H "Cookie: resell_uid=1" -F file=@card.heic http://<app>:3000/api/giftcard-ocr
 */

import { NextRequest } from 'next/server';
import { getSessionUserId } from '@/lib/auth';
import { giftCardOcrGate, giftCardOcrHealth, readGiftCardImage } from '@/lib/giftCardOcr';

export async function GET() {
  const gate = giftCardOcrGate();
  if (gate) return gate;

  const userId = await getSessionUserId();
  if (userId == null) return Response.json({ error: 'not authenticated' }, { status: 401 });

  try {
    return Response.json(await giftCardOcrHealth());
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 502 });
  }
}

export async function POST(req: NextRequest) {
  const gate = giftCardOcrGate();
  if (gate) return gate;

  // Authenticated even though it touches no data: each call is seconds of CPU
  // on a shared box, so an unauthenticated one is a free denial-of-service.
  const userId = await getSessionUserId();
  if (userId == null) return Response.json({ error: 'not authenticated' }, { status: 401 });

  try {
    const form = await req.formData();
    const file = form.get('file');
    if (!(file instanceof Blob)) {
      return Response.json({ error: 'expected a multipart "file" part' }, { status: 400 });
    }
    const variants = req.nextUrl.searchParams.get('variants');
    const result = await readGiftCardImage(file, {
      filename: file instanceof File ? file.name : 'upload',
      variants: variants ? variants.split(',').map(v => v.trim()).filter(Boolean) : undefined,
      includeWindows: req.nextUrl.searchParams.get('include_windows') === 'true',
    });
    return Response.json(result);
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 502 });
  }
}
