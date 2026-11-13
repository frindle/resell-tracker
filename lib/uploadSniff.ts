// Upload safety: decide a file's type from its bytes, never from the client's
// Content-Type or file name, and build response headers that keep a served upload
// from running as a page (stored XSS). Pure: no db or fs imports.

// 25 MB: full-resolution iPhone JPEGs (48 MP) run past 10 MB, and the bulk photo upload would drop them.
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export type SniffedType = { mime: string; ext: string };

const ascii = (b: Uint8Array, from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
const HEIC_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'heif', 'mif1', 'msf1']);

/** pdf / png / jpeg / webp / heic by magic bytes; null for anything else. */
export function sniffUpload(buf: Uint8Array): SniffedType | null {
  if (buf.length >= 5 && ascii(buf, 0, 5) === '%PDF-') return { mime: 'application/pdf', ext: '.pdf' };
  if (buf.length >= 8 && buf[0] === 0x89 && ascii(buf, 1, 4) === 'PNG' && buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) {
    return { mime: 'image/png', ext: '.png' };
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg', ext: '.jpg' };
  if (buf.length >= 12 && ascii(buf, 0, 4) === 'RIFF' && ascii(buf, 8, 12) === 'WEBP') return { mime: 'image/webp', ext: '.webp' };
  if (buf.length >= 12 && ascii(buf, 4, 8) === 'ftyp' && HEIC_BRANDS.has(ascii(buf, 8, 12))) return { mime: 'image/heic', ext: '.heic' };
  return null;
}

/**
 * Headers for serving stored bytes: the detected type, no sniffing, attachment unless image or pdf.
 * Everything but PDF is also CSP-sandboxed. Chrome's built-in PDF viewer will not open a document served
 * with `sandbox`, and a PDF (typed application/pdf, nosniff) is rendered by the viewer, never as a page.
 */
export function safeServeHeaders(sniffed: SniffedType | null, originalName: string | null | undefined): Record<string, string> {
  const inline = sniffed != null;
  const name = (originalName ?? 'attachment').replace(/[^\w.\- ]/g, '_');
  const h: Record<string, string> = {
    'Content-Type': sniffed?.mime ?? 'application/octet-stream',
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${name}"`,
    'X-Content-Type-Options': 'nosniff',
  };
  if (sniffed?.mime !== 'application/pdf') h['Content-Security-Policy'] = 'sandbox';
  return h;
}

/** null when fine, else a message for a 400. */
export function uploadProblem(buf: Uint8Array): string | null {
  if (buf.length > MAX_UPLOAD_BYTES) return `file is larger than ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`;
  if (!sniffUpload(buf)) return 'only pdf, png, jpeg, webp or heic files are allowed';
  return null;
}
