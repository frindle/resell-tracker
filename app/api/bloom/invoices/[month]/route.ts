import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { NextRequest } from 'next/server';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ month: string }> }) {
  try {
    const userId = await getSessionUserId();
    if (userId == null) return Response.json({ error: 'sign in required' }, { status: 401 });
    const { month } = await params;
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return Response.json({ error: 'bad month' }, { status: 400 });
    const row = await prisma.bloomInvoice.findUnique({ where: { userId_month: { userId, month } } });
    if (!row) return Response.json({ error: 'no invoice for that month' }, { status: 404 });
    return Response.json({ ...JSON.parse(row.payload), fetchedAt: row.fetchedAt });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
