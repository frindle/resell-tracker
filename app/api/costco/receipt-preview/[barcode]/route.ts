import { readFile } from 'fs/promises';
import { join } from 'path';

const RECEIPT_PREVIEW_DIR = '/data/files/costco-receipt-previews';

export async function GET(_req: Request, { params }: { params: Promise<{ barcode: string }> }) {
  const { barcode } = await params;
  // Only allow alphanumeric and hyphens to prevent path traversal
  if (!/^[\w-]+$/.test(barcode)) return new Response('Bad barcode', { status: 400 });

  try {
    const html = await readFile(join(RECEIPT_PREVIEW_DIR, `${barcode}.html`), 'utf-8');
    return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  } catch {
    return new Response('Preview not found', { status: 404 });
  }
}
