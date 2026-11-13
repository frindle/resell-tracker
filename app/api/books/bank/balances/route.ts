import { NextRequest } from 'next/server';
import { withBooks } from '@/lib/books/api';
import { prisma } from '@/lib/db';
import { setManualBalance, deleteManualBalance, HttpError } from '@/lib/books/bank/service';

/** Statement balances for one account: ?accountId= . */
export async function GET(req: NextRequest) {
  return withBooks(async userId => {
    const id = Number(req.nextUrl.searchParams.get('accountId'));
    if (!Number.isInteger(id)) return Response.json({ error: 'accountId required' }, { status: 400 });
    const acct = await prisma.bankAccount.findFirst({ where: { id, userId }, select: { id: true } });
    if (!acct) return Response.json({ error: 'not found' }, { status: 404 });
    return Response.json(await prisma.statementBalance.findMany({ where: { bankAccountId: id }, orderBy: { date: 'desc' }, take: 120 }));
  });
}

/** Body { accountId, date: 'YYYY-MM-DD', balanceCents }: a balance typed from a statement. */
export async function POST(req: NextRequest) {
  return withBooks(async userId => {
    const b = await req.json().catch(() => ({}));
    try { return Response.json(await setManualBalance(userId, Number(b.accountId), String(b.date), Number(b.balanceCents))); }
    catch (e) { if (e instanceof HttpError) return Response.json({ error: e.message }, { status: e.status }); throw e; }
  });
}

export async function DELETE(req: NextRequest) {
  return withBooks(async userId => {
    const b = await req.json().catch(() => ({}));
    try { return Response.json(await deleteManualBalance(userId, Number(b.accountId), String(b.date))); }
    catch (e) { if (e instanceof HttpError) return Response.json({ error: e.message }, { status: e.status }); throw e; }
  });
}
