import { prisma } from '@/lib/db';
import { writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const FILES_DIR = '/data/files';
const TAG = 'delivery-photo';
const MAX_BYTES = 5 * 1024 * 1024; // 5 MB — Amazon thumbs are ~50-150 KB; cap defends against signed URLs that point at something huge

// Download a delivery photo from a signed URL and attach to the order.
// Idempotent: if we already saved a delivery photo for this order (any
// originalName starting with "delivery-photo-"), skip. Walmart + Amazon
// rotate signing every load, so we can't dedupe by URL.
//
// Safe to call fire-and-forget — never throws. Logs failures so they
// surface in /api-errors if you want to wire that in later.
export async function captureDeliveryPhoto(
  orderId: number,
  url: string,
  platform: string,
): Promise<void> {
  try {
    if (!url || !/^https?:\/\//i.test(url)) return;

    const existing = await prisma.orderAttachment.findFirst({
      where: { orderId, originalName: { startsWith: `${TAG}-` } },
      select: { id: true },
    });
    if (existing) return;

    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) {
      console.warn(`[${TAG}] order ${orderId} (${platform}): HTTP ${res.status} fetching photo`);
      return;
    }
    const ctype = res.headers.get('content-type') || 'image/jpeg';
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0) return;
    if (buf.length > MAX_BYTES) {
      console.warn(`[${TAG}] order ${orderId} (${platform}): ${buf.length} bytes exceeds ${MAX_BYTES} cap, skipping`);
      return;
    }

    const ext = ctype.includes('png') ? '.png' : ctype.includes('webp') ? '.webp' : '.jpg';
    const filename = `${randomUUID()}${ext}`;
    const orderDir = join(FILES_DIR, String(orderId));
    if (!existsSync(orderDir)) await mkdir(orderDir, { recursive: true });
    await writeFile(join(orderDir, filename), buf);

    await prisma.orderAttachment.create({
      data: {
        orderId,
        filename,
        originalName: `${TAG}-${platform.toLowerCase()}.jpg`,
        mimeType: ctype,
      },
    });
    console.log(`[${TAG}] order ${orderId} (${platform}): saved ${buf.length} bytes`);
  } catch (e) {
    console.warn(`[${TAG}] order ${orderId} (${platform}) failed:`, String(e).slice(0, 200));
  }
}
