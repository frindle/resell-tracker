import { prisma } from '@/lib/db';
import { bloomUser } from '@/lib/bloomRequest';
import { NextRequest } from 'next/server';

export async function GET(req: NextRequest, { params }: { params: Promise<{ month: string }> }) {
  try {
    const who = await bloomUser();
    if ('error' in who) return Response.json({ error: who.error }, { status: who.status });
    const userId = who.userId;
    const { month } = await params;
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return Response.json({ error: 'bad month' }, { status: 400 });
    const copy = req.nextUrl.searchParams.get('copy');
    const copies = await prisma.bloomInvoiceCopy.findMany({ where: { userId, month }, orderBy: { copy: 'asc' }, select: { copy: true, payload: true, createdAt: true } });
    if (copy !== null) {   // one stored copy, exactly as written
      const c = copies.find(x => String(x.copy) === copy);
      if (!c) return Response.json({ error: 'no such copy' }, { status: 404 });
      return Response.json({ ...JSON.parse(c.payload), createdAt: c.createdAt });
    }
    const row = await prisma.bloomInvoice.findUnique({ where: { userId_month: { userId, month } } });
    if (!row) return Response.json({ error: 'no invoice for that month' }, { status: 404 });
    return Response.json({ ...JSON.parse(row.payload), fetchedAt: row.fetchedAt, copies: copies.map(c => ({ copy: c.copy, createdAt: c.createdAt })) });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
