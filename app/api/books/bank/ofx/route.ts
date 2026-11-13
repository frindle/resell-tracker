import { NextRequest } from 'next/server';
import { withBooks } from '@/lib/books/api';
import { importOfx } from '@/lib/books/bank/service';
import { MAX_OFX_BYTES } from '@/lib/books/bank/ofx';

/** multipart: file (.ofx / .qfx, up to 25 MB), optional bankAccountId. Re-uploading the same file inserts nothing. */
export async function POST(req: NextRequest) {
  return withBooks(async userId => {
    const form = await req.formData();
    const file = form.get('file');
    if (!(file instanceof File)) return Response.json({ error: 'file required' }, { status: 400 });
    if (file.size > MAX_OFX_BYTES) return Response.json({ error: 'file is larger than 25 MB' }, { status: 413 });
    const acct = form.get('bankAccountId');
    try {
      return Response.json({ ok: true, ...(await importOfx(userId, new Uint8Array(await file.arrayBuffer()), acct ? Number(acct) : undefined)) });
    } catch (e) {
      return Response.json({ error: e instanceof Error ? e.message : 'import failed' }, { status: 400 });
    }
  });
}
