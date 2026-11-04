import { NextRequest } from 'next/server';
import { getSessionUserId } from '@/lib/auth';
import { saveUnassignedPhoto, findDuplicatePhoto } from '@/lib/unassignedPhotos';
import { enqueuePhotoOcr } from '@/lib/photoOcrRun';
import { isAllowedIcloudDownload } from '@/lib/icloudLink';

// Step 2 of an iCloud link import: download ONE photo the list step found
// and drop it in the unassigned pool. One photo per request keeps every
// request well under Cloudflare's ~100 s proxy timeout.
//
// The download URL comes from the browser, so it is only fetched when it is
// https on Apple's own photo hosts (isAllowedIcloudDownload): nothing else.

const MAX_BYTES = 30 * 1024 * 1024;

const TYPES: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', heic: 'image/heic', heif: 'image/heif', webp: 'image/webp' };

export async function POST(req: NextRequest) {
  const uid = await getSessionUserId();
  if (uid == null) return Response.json({ error: 'not authenticated' }, { status: 401 });
  const body = await req.json().catch(() => ({})) as { key?: string; name?: string; takenAt?: string | null; downloadUrl?: string };
  const key = (body.key ?? '').trim().slice(0, 200);
  if (!key || !body.downloadUrl) return Response.json({ error: 'key and downloadUrl are required' }, { status: 400 });
  if (!isAllowedIcloudDownload(body.downloadUrl)) return Response.json({ error: 'not an iCloud photo address' }, { status: 400 });

  const sourceKey = `icloud:${key}`;
  // Cheap check first: same iCloud photo already imported, no download needed.
  const known = await findDuplicatePhoto(uid, Buffer.alloc(0), sourceKey);
  if (known) return Response.json({ status: 'duplicate', assigned: known.orderId != null });

  let res: Response;
  try {
    res = await fetch(body.downloadUrl, { signal: AbortSignal.timeout(60_000), redirect: 'error' });
  } catch (e) {
    return Response.json({ error: `download failed: ${String(e).slice(0, 120)}` }, { status: 502 });
  }
  if (!res.ok) return Response.json({ error: `iCloud returned HTTP ${res.status} (the link may have expired; list it again)` }, { status: 502 });
  const len = Number(res.headers.get('content-length') ?? 0);
  if (len > MAX_BYTES) return Response.json({ error: 'over 30 MB' }, { status: 413 });
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length === 0 || buffer.length > MAX_BYTES) return Response.json({ error: buffer.length ? 'over 30 MB' : 'empty file' }, { status: 413 });

  const name = (body.name ?? '').trim().slice(0, 200) || `icloud-${key.slice(0, 12)}.jpg`;
  const ext = name.toLowerCase().split('.').pop() ?? '';
  const headerType = (res.headers.get('content-type') ?? '').split(';')[0].trim();
  const mime = headerType.startsWith('image/') ? headerType : TYPES[ext];
  if (!mime) return Response.json({ error: 'not an image' }, { status: 415 });

  const dup = await findDuplicatePhoto(uid, buffer, sourceKey);
  if (dup) return Response.json({ status: 'duplicate', assigned: dup.orderId != null });

  const att = await saveUnassignedPhoto(uid, buffer, name, mime, { sourceKey });
  const takenAt = body.takenAt ? new Date(body.takenAt) : null;
  await enqueuePhotoOcr(att.id, takenAt && !isNaN(takenAt.getTime()) ? takenAt : null);
  return Response.json({ status: 'uploaded', id: att.id });
}
