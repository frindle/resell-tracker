import { NextRequest } from 'next/server';
import { userForUploadToken } from '@/lib/uploadTokens';
import { saveUnassignedPhoto, findDuplicatePhoto } from '@/lib/unassignedPhotos';
import { enqueuePhotoOcr } from '@/lib/photoOcrRun';

// Photo upload for the iOS Shortcut (or anything else outside the browser).
// Auth: `Authorization: Bearer <upload token>` from Settings > Phone uploads.
// proxy.ts lets /api/upload through without a session cookie; this handler
// is the only check, and it accepts nothing but a valid, unrevoked token.
//
// Body, either:
//   - multipart/form-data with one or more `file` (or `files`) parts, or
//   - the raw image bytes with an image/* Content-Type
//     (Shortcuts "Get Contents of URL", Request Body: File).
// Optional photo date: `X-Captured-At` header, `capturedAt` query/form field
// (ISO 8601, or anything Date can parse). Helps match receipts with no date.
//
// Optional `X-Photo-Id`: the sender's own id for the photo (the Shortcut
// sends file name + creation date). A photo already uploaded (same id, or
// same bytes) is skipped and reported as a duplicate with 200, so re-sending
// a whole batch after one failure is safe.
//
// Photos land in the unassigned pool (/orders/sort-assign) and are queued
// for OCR + order matching.

const MAX_BYTES = 30 * 1024 * 1024;

function parseDate(v: string | null | undefined): Date | null {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

const EXT: Record<string, string> = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/heic': '.heic', 'image/heif': '.heif', 'image/webp': '.webp',
};

// Every response carries `status` and a one-line `summary` the Shortcut can
// show as-is ("IMG_1234.jpg: uploaded"), errors included.
function fail(error: string, httpStatus: number, label = 'Upload') {
  return Response.json({ status: 'error', error, summary: `${label}: failed, ${error}` }, { status: httpStatus });
}

// Shortcuts sometimes labels a form file part application/octet-stream;
// fall back to the file extension.
function imageType(type: string, name: string): string {
  if (type.startsWith('image/')) return type;
  const ext = name.toLowerCase().split('.').pop() ?? '';
  return Object.entries(EXT).find(([, e]) => e === `.${ext}`)?.[0] ?? (ext === 'jpeg' ? 'image/jpeg' : type);
}

export async function POST(req: NextRequest) {
  const auth = await userForUploadToken(req.headers.get('authorization'));
  if (auth == null) return fail('invalid or missing upload key', 401);

  const uid = auth.userId;
  const len = Number(req.headers.get('content-length') ?? 0);
  if (len > MAX_BYTES * 10) return fail('upload too large', 413);

  let capturedAt = parseDate(req.headers.get('x-captured-at')) ?? parseDate(req.nextUrl.searchParams.get('capturedAt'));
  const files: { buffer: Buffer; name: string; type: string }[] = [];
  const ctype = (req.headers.get('content-type') ?? '').toLowerCase();

  if (ctype.startsWith('multipart/form-data')) {
    const form = await req.formData();
    capturedAt = capturedAt ?? parseDate(form.get('capturedAt')?.toString());
    for (const f of [...form.getAll('file'), ...form.getAll('files')]) {
      if (f instanceof File) files.push({ buffer: Buffer.from(await f.arrayBuffer()), name: f.name || 'photo', type: imageType(f.type, f.name || '') });
    }
  } else if (ctype.startsWith('image/')) {
    const type = ctype.split(';')[0].trim();
    const name = req.nextUrl.searchParams.get('name') || `shortcut-${Date.now()}${EXT[type] ?? ''}`;
    files.push({ buffer: Buffer.from(await req.arrayBuffer()), name, type });
  } else {
    return fail('send a form with a "file" field, or raw image bytes with an image/* Content-Type', 415);
  }

  if (files.length === 0) return fail('no file in the request', 400);
  const sourceKey = req.headers.get('x-photo-id')?.trim().slice(0, 300) || null;
  const created = [];
  const duplicates = [];
  for (const f of files) {
    if (f.buffer.length === 0) continue;
    if (f.buffer.length > MAX_BYTES) return fail('over 30 MB', 413, f.name);
    if (!f.type.startsWith('image/')) return fail('not an image', 415, f.name);
    // The sender id names one photo, so it only applies to a single-file request.
    const key = files.length === 1 ? sourceKey : null;
    const dup = await findDuplicatePhoto(uid, f.buffer, key);
    if (dup) { duplicates.push({ id: dup.id, name: dup.originalName, assigned: dup.orderId != null }); continue; }
    const att = await saveUnassignedPhoto(uid, f.buffer, f.name, f.type, { sourceKey: key, uploadTokenId: auth.tokenId });
    await enqueuePhotoOcr(att.id, capturedAt);
    created.push({ id: att.id, name: att.originalName });
  }
  const status = created.length ? 'uploaded' : duplicates.length ? 'duplicate' : 'empty';
  const summary = [
    ...created.map(c => `${c.name}: uploaded`),
    ...duplicates.map(d => `${d.name}: already uploaded${d.assigned ? ' (on an order)' : ''}, skipped`),
  ].join('\n') || 'Upload: the file was empty';
  return Response.json({ status, summary, uploaded: created.length, duplicates: duplicates.length, photos: created, duplicatePhotos: duplicates });
}
