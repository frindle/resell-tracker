import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { withBooks } from '@/lib/books/api';
import { readFile } from 'fs/promises';
import { join } from 'path';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withBooks(async userId => {
    const { id } = await params;
    const row = await prisma.costEntry.findFirst({ where: { id: Number(id), userId } });
    if (!row?.attachmentFile) return Response.json({ error: 'no attachment' }, { status: 404 });
    const buf = await readFile(join('/data/files/costs', String(row.id), row.attachmentFile));
    return new Response(new Uint8Array(buf), {
      headers: {
        'Content-Type': row.attachmentMime ?? 'application/octet-stream',
        'Content-Disposition': `inline; filename="${(row.attachmentName ?? 'attachment').replace(/[^\w.\- ]/g, '_')}"`,
      },
    });
  });
}
