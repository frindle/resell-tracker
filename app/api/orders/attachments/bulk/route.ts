import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { resolveExtensionUserId } from '@/lib/extensionAuth';
import { NextRequest } from 'next/server';
import { saveUnassignedPhoto, findDuplicatePhoto } from '@/lib/unassignedPhotos';
import { enqueuePhotoOcr } from '@/lib/photoOcrRun';
import { sniffUpload, uploadProblem } from '@/lib/uploadSniff';

// Bulk photo upload: lands each file as an unassigned OrderAttachment
// (orderId null) rather than requiring an order to be picked per-file up
// front. Sort onto orders afterward via /orders/sort-assign, same pattern
// as the existing single-order attachment upload but without the order
// context. See prisma/migrations/20260823192500_*. Each image is also
// queued for OCR + order matching (lib/photoOcrRun.ts) when OCR is on.
export async function POST(req: NextRequest) {
  const sessionUid = await getSessionUserId();
  const uid = resolveExtensionUserId(req, sessionUid);
  if (uid == null) return Response.json({ error: 'not authenticated' }, { status: 401 });

  const formData = await req.formData();
  const files = formData.getAll('files').filter((f): f is File => f instanceof File);
  if (files.length === 0) return Response.json({ error: 'no files' }, { status: 400 });

  // A photo already uploaded (same bytes, assigned or not) is skipped, so
  // re-selecting a batch after a failure doesn't add the rest twice.
  const created = [];
  let duplicates = 0;
  const existing: { id: number; orderId: number | null }[] = [];
  const rejected: { name: string; error: string }[] = [];
  for (const file of files) {
    const buffer = Buffer.from(await file.arrayBuffer());
    const bad = uploadProblem(buffer);
    if (bad) { rejected.push({ name: file.name, error: bad }); continue; }
    const dup = await findDuplicatePhoto(uid, buffer);
    if (dup) { duplicates++; existing.push({ id: dup.id, orderId: dup.orderId }); continue; }
    const attachment = await saveUnassignedPhoto(uid, buffer, file.name, sniffUpload(buffer)!.mime);
    if (attachment.mimeType.startsWith('image/')) await enqueuePhotoOcr(attachment.id);
    created.push(attachment);
  }

  // existing: the photo each duplicate already is, so a drop on the order form can still add it.
  return Response.json({ created: created.length, duplicates, rejected, attachments: created, existing });
}
