import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { parseLoanBody, summarizeLoan } from '@/lib/loans';
import { NextRequest } from 'next/server';

export async function GET() {
  try {
    const userId = await getSessionUserId();
    const loans = await prisma.loan.findMany({
      where: { userId: userId ?? null },
      orderBy: { createdAt: 'asc' },
      include: { entries: { orderBy: { postedAt: 'asc' } }, card: { select: { id: true, name: true, last4: true } } },
    });
    const now = new Date();
    return Response.json(loans.map(l => ({ ...l, summary: summarizeLoan(l, now) })));
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const userId = await getSessionUserId();
    const parsed = parseLoanBody(await req.json());
    if ('error' in parsed) return Response.json({ error: parsed.error }, { status: 400 });
    const data = parsed.ok;
    if (data.cardId !== null) {
      const card = await prisma.creditCard.findFirst({ where: { id: data.cardId, userId: userId ?? null } });
      if (!card) return Response.json({ error: 'card not found' }, { status: 400 });
    }
    const loan = await prisma.loan.create({ data: { ...data, userId: userId ?? null } });
    return Response.json(loan, { status: 201 });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
