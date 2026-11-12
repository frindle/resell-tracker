import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { withBooks } from '@/lib/books/api';

export async function GET(req: NextRequest) {
  return withBooks(async userId => {
    const limit = Math.min(500, Math.max(1, Number(req.nextUrl.searchParams.get('limit')) || 100));
    const rows = await prisma.journalEntry.findMany({
      where: { userId }, orderBy: { id: 'desc' }, take: limit,
      include: { lines: { include: { account: { select: { code: true, name: true } } } } },
    });
    return Response.json(rows);
  });
}
