import { NextRequest } from 'next/server';
import { withBooks } from '@/lib/books/api';
import { prisma } from '@/lib/db';

/** Body: any of { creditCardId, ledgerAccountId, last4, name } (null clears a link). */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withBooks(async userId => {
    const { id } = await params;
    const a = await prisma.bankAccount.findFirst({ where: { id: Number(id), userId } });
    if (!a) return Response.json({ error: 'not found' }, { status: 404 });
    const body = await req.json().catch(() => ({}));
    const data: { creditCardId?: number | null; ledgerAccountId?: number | null; last4?: string | null; name?: string } = {};
    if ('creditCardId' in body) {
      if (body.creditCardId != null && !(await prisma.creditCard.findFirst({ where: { id: Number(body.creditCardId), userId } }))) return Response.json({ error: 'unknown card' }, { status: 400 });
      data.creditCardId = body.creditCardId == null ? null : Number(body.creditCardId);
    }
    if ('ledgerAccountId' in body) {
      if (body.ledgerAccountId != null && !(await prisma.ledgerAccount.findFirst({ where: { id: Number(body.ledgerAccountId), userId } }))) return Response.json({ error: 'unknown ledger account' }, { status: 400 });
      data.ledgerAccountId = body.ledgerAccountId == null ? null : Number(body.ledgerAccountId);
    }
    if ('last4' in body) {
      if (body.last4 != null && !/^\d{4}$/.test(String(body.last4))) return Response.json({ error: 'last4 must be 4 digits' }, { status: 400 });
      data.last4 = body.last4 == null ? null : String(body.last4);
    }
    if (typeof body.name === 'string' && body.name.trim()) data.name = body.name.trim().slice(0, 120);
    await prisma.bankAccount.update({ where: { id: a.id }, data });
    return Response.json({ ok: true });
  });
}
