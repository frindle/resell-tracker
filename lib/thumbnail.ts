import { join, basename, extname } from 'path';
import sharp from 'sharp';
import convertHeic from 'heic-convert';

// Shared thumbnail pipeline for the unassigned (bulk-triage) photo pool.
//
// The triage grid was shipping every unassigned photo at full original size
// (often several MB each, more for HEIC) just to render small squares --
// 30-40 of those loading/decoding at once is exactly what was making the
// page slow and, per Penn, possibly leaking memory. sharp's prebuilt binary
// can't decode real HEIC (licensing -- it only lists .avif under the heif
// format, confirmed by testing against real HEIC files: fails with "Support
// for this compression format has not been built in"), so HEIC goes through
// heic-convert (WASM libheif, no native licensing issue) to get a JPEG
// buffer first, then sharp resizes whatever we've got.
//
// The expensive part (HEIC decode + EXIF normalize + resize) runs ONCE at
// import time and is cached as an "unrotated thumbnail" file next to the
// original (see unassignedThumbPath). The user's saved rotation is NOT
// baked into that cache -- it can change any time after upload via the
// rotate button, and nothing would invalidate a stale cache -- so it's
// applied as a cheap second pass at read time on the small cached JPEG.
const FILES_DIR = '/data/files';
const UNASSIGNED_DIR = join(FILES_DIR, 'unassigned');
export const THUMB_SIZE = 320;

// Cached unrotated thumbnails live in a dot-directory so they're clearly
// not real uploaded content (the original is <uuid><ext>; the cache is
// <uuid>.jpg in unassigned/.thumbs/).
export const UNASSIGNED_THUMB_DIR = join(UNASSIGNED_DIR, '.thumbs');

export function unassignedThumbPath(filename: string): string {
  return join(UNASSIGNED_THUMB_DIR, basename(filename, extname(filename)) + '.jpg');
}

async function toJpegSource(buffer: Buffer, mimeType: string): Promise<Buffer> {
  return mimeType === 'image/heic' || mimeType === 'image/heif'
    ? Buffer.from(await convertHeic({ buffer, format: 'JPEG', quality: 0.9 }))
    : buffer;
}

// The expensive, rotation-independent part of the pipeline: HEIC conversion
// (if needed) + EXIF-orientation normalize + resize to THUMB_SIZE square.
// Runs at import time; the result is cached to disk.
export async function makeUnrotatedThumbnail(buffer: Buffer, mimeType: string): Promise<Buffer> {
  const source = await toJpegSource(buffer, mimeType);
  // sharp's .rotate(angle) with an explicit angle replaces its automatic
  // EXIF-orientation handling rather than adding to it -- normalize via
  // EXIF first (a plain .rotate() call).
  const exifNormalized = await sharp(source).rotate().toBuffer();
  return sharp(exifNormalized).resize(THUMB_SIZE, THUMB_SIZE, { fit: 'cover' }).jpeg({ quality: 78 }).toBuffer();
}

// Cheap read-time pass: apply the user's saved rotation on top of a small
// cached unrotated thumbnail. No-op when rotation is 0.
export async function rotateThumbnail(thumb: Buffer, rotation: number): Promise<Buffer> {
  return rotation ? sharp(thumb).rotate(rotation).toBuffer() : thumb;
}

// Full fresh-from-original pipeline (HEIC + EXIF normalize + user rotation +
// resize), in the original order. Only used as the read-time fallback when
// no cached unrotated thumbnail exists (attachment predates the cache, or
// import-time generation failed for that file).
export async function makeThumbnail(buffer: Buffer, mimeType: string, rotation: number): Promise<Buffer> {
  if (!rotation) return makeUnrotatedThumbnail(buffer, mimeType);
  const source = await toJpegSource(buffer, mimeType);
  const exifNormalized = await sharp(source).rotate().toBuffer();
  const oriented = await sharp(exifNormalized).rotate(rotation).toBuffer();
  return sharp(oriented).resize(THUMB_SIZE, THUMB_SIZE, { fit: 'cover' }).jpeg({ quality: 78 }).toBuffer();
}
