import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { parseLoanBody } from '@/lib/loans';
import { NextRequest } from 'next/server';

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = await getSessionUserId();
    const { id } = await params;
    const parsed = parseLoanBody(await req.json());
    if ('error' in parsed) return Response.json({ error: parsed.error }, { status: 400 });
    const data = parsed.ok;
    if (data.cardId !== null) {
      const card = await prisma.creditCard.findFirst({ where: { id: data.cardId, userId: userId ?? null } });
      if (!card) return Response.json({ error: 'card not found' }, { status: 400 });
    }
    const loan = await prisma.loan.update({ where: { id: parseInt(id), userId: userId ?? null }, data });
    return Response.json(loan);
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}

// Entries go with the loan (ON DELETE CASCADE); the page asks before calling this.
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = await getSessionUserId();
    const { id } = await params;
    await prisma.loan.delete({ where: { id: parseInt(id), userId: userId ?? null } });
    return new Response(null, { status: 204 });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
