import { prisma } from '@/lib/db';
import { writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const FILES_DIR = '/data/files';
const TAG = 'delivery-photo';
const MAX_BYTES = 5 * 1024 * 1024; // 5 MB — Amazon thumbs are ~50-150 KB; cap defends against signed URLs that point at something huge

// Download a delivery photo and attach to the order. Two ingestion paths:
// - URL only (Amazon S3 — signed, self-contained — server fetches directly).
// - URL + base64 bytes from extension (Walmart — URL requires the user's
//   session cookies, so the extension fetches in-page and forwards bytes).
//
// Idempotent: if we already saved a delivery photo for this order (any
// originalName starting with "delivery-photo-"), skip and log so we can
// tell "skipped, already attached" from "the URL wasn't extracted."
//
// Safe to call fire-and-forget — never throws.
export async function captureDeliveryPhoto(
  orderId: number,
  url: string | null | undefined,
  platform: string,
  inlineBase64?: string,
  inlineMime?: string,
): Promise<void> {
  try {
    const existing = await prisma.orderAttachment.findFirst({
      where: { orderId, originalName: { startsWith: `${TAG}-` } },
      select: { id: true },
    });
    if (existing) {
      console.log(`[${TAG}] order ${orderId} (${platform}): already has attachment, skipping`);
      return;
    }

    let buf: Buffer;
    let ctype: string;

    if (inlineBase64) {
      // Path 2: extension already fetched the bytes (Walmart). Decode and
      // skip the URL fetch.
      try {
        buf = Buffer.from(inlineBase64, 'base64');
      } catch (e) {
        console.warn(`[${TAG}] order ${orderId} (${platform}): base64 decode failed:`, String(e).slice(0, 200));
        return;
      }
      ctype = inlineMime || 'image/jpeg';
      console.log(`[${TAG}] order ${orderId} (${platform}): using inline bytes from extension`);
    } else {
      // Path 1: signed URL the server can fetch (Amazon S3).
      if (!url || !/^https?:\/\//i.test(url)) return;
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) {
        console.warn(`[${TAG}] order ${orderId} (${platform}): HTTP ${res.status} fetching photo`);
        return;
      }
      ctype = res.headers.get('content-type') || 'image/jpeg';
      buf = Buffer.from(await res.arrayBuffer());
    }

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
