import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { withBooks } from '@/lib/books/api';

export async function GET(req: NextRequest) {
  return withBooks(async userId => {
    const limit = Math.min(500, Math.max(1, Number(req.nextUrl.searchParams.get('limit')) || 100));
    const sp = req.nextUrl.searchParams;
    const account = sp.get('account')?.trim();   // account code, e.g. 1400
    const orderId = Number(sp.get('orderId'));
    const source = sp.get('source')?.trim();
    const lineWhere: Record<string, unknown> = {};
    if (account) lineWhere.account = { code: account, userId };
    if (Number.isInteger(orderId) && orderId > 0) lineWhere.orderId = orderId;
    const rows = await prisma.journalEntry.findMany({
      where: { userId, ...(source ? { source } : {}), ...(Object.keys(lineWhere).length ? { lines: { some: lineWhere } } : {}) }, orderBy: { id: 'desc' }, take: limit,
      include: { lines: { include: { account: { select: { code: true, name: true } } } } },
    });
    return Response.json(rows);
  });
}
