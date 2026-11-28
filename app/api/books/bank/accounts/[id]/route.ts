import { NextRequest } from 'next/server';
import { withBooks } from '@/lib/books/api';
import { prisma } from '@/lib/db';
import { hideRefusal } from '@/lib/books/bank/hide';
import { setAccountClosed, writeOffClosedBalance, HttpError } from '@/lib/books/bank/service';

/** Body: any of { creditCardId, ledgerAccountId, last4, name, hidden, closedOn } (null clears a link; closedOn is a YYYY-MM-DD day, or null to reopen; a day before the last posted row is refused). writeOff:true settles what a closed account still holds. hidden:true is refused (409) while the account is in the books. */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withBooks(async userId => {
    const { id } = await params;
    const a = await prisma.bankAccount.findFirst({ where: { id: Number(id), userId } });
    if (!a) return Response.json({ error: 'not found' }, { status: 404 });
    const body = await req.json().catch(() => ({}));
    try {
      if ('closedOn' in body) await setAccountClosed(userId, a.id, body.closedOn == null ? null : String(body.closedOn));
      if (body.writeOff === true) return Response.json(await writeOffClosedBalance(userId, a.id));
    } catch (e) { if (e instanceof HttpError) return Response.json({ error: e.message }, { status: e.status }); throw e; }
    const data: { creditCardId?: number | null; ledgerAccountId?: number | null; last4?: string | null; name?: string; hidden?: boolean } = {};
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
    if ('hidden' in body) {
      if (typeof body.hidden !== 'boolean') return Response.json({ error: 'hidden must be true or false' }, { status: 400 });
      data.hidden = body.hidden;
    }
    // Judged on the account as it would be after this change, so a link set in the same request counts.
    const after = { creditCardId: data.creditCardId !== undefined ? data.creditCardId : a.creditCardId, ledgerAccountId: data.ledgerAccountId !== undefined ? data.ledgerAccountId : a.ledgerAccountId, hidden: data.hidden ?? a.hidden };
    const refusal = hideRefusal(after);
    if (refusal) return Response.json({ error: refusal }, { status: 409 });
    await prisma.bankAccount.update({ where: { id: a.id }, data });
    return Response.json({ ok: true });
  });
}
