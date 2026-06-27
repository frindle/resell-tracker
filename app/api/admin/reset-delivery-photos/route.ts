import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';

const FILES_DIR = '/data/files';
const TAG = 'delivery-photo';

// One-shot admin reset: wipe every OrderAttachment row whose originalName
// starts with "delivery-photo-" AND remove the bytes from disk. The next
// sync will re-attempt capture for each delivered order (Amazon via S3
// URL fetch on the server, Walmart via the in-page bytes the extension
// forwards).
//
// Auth: session cookie (the order ownership filter is per-user, so other
// users' attachments aren't affected).
//
// POST /api/admin/reset-delivery-photos
//   → { deleted: N, filesRemoved: M, filesMissing: K }
export async function POST() {
  try {
    const userId = await getSessionUserId();
    if (userId == null) return Response.json({ error: 'not authenticated' }, { status: 401 });

    const attachments = await prisma.orderAttachment.findMany({
      where: {
        originalName: { startsWith: `${TAG}-` },
        order: { userId },
      },
      select: { id: true, orderId: true, filename: true },
    });

    let filesRemoved = 0;
    let filesMissing = 0;
    for (const a of attachments) {
      try {
        await unlink(join(FILES_DIR, String(a.orderId), a.filename));
        filesRemoved++;
      } catch {
        filesMissing++;
      }
    }

    const { count: deleted } = await prisma.orderAttachment.deleteMany({
      where: { id: { in: attachments.map(a => a.id) } },
    });

    console.log(`[reset-delivery-photos] user=${userId} deleted=${deleted} files=${filesRemoved} missing=${filesMissing}`);
    return Response.json({ deleted, filesRemoved, filesMissing });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
