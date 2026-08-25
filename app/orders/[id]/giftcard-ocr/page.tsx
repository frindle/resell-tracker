/**
 * Gift-card OCR review screen.
 *
 * DORMANT. `notFound()` fires before anything renders unless
 * GIFTCARD_OCR_ENABLED === 'true', and nothing links here — no nav entry, no
 * button on the order page. With the flag off this URL is a 404, identical to a
 * route that does not exist.
 *
 * Reachable, when enabled, at /orders/<id>/giftcard-ocr.
 */

import { notFound } from 'next/navigation';
import { isGiftCardOcrEnabled } from '@/lib/giftCardOcr';
import GiftCardOcrReview from '@/components/GiftCardOcrReview';

export default async function GiftCardOcrPage({ params }: { params: Promise<{ id: string }> }) {
  if (!isGiftCardOcrEnabled()) notFound();
  const { id } = await params;
  const orderId = parseInt(id);
  if (isNaN(orderId)) notFound();
  return <GiftCardOcrReview orderId={orderId} />;
}
