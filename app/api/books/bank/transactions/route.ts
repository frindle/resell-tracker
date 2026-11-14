import { NextRequest } from 'next/server';
import { withBooks } from '@/lib/books/api';
import { prisma } from '@/lib/db';
import { txnListWhere } from '@/lib/books/bank/service';

/** ?accountId=&status=unmatched|suggested|matched|ignored&hidePersonal=1&limit= (default 200, max 1000). Newest first. */
export async function GET(req: NextRequest) {
  return withBooks(async userId => {
    const q = req.nextUrl.searchParams;
    const accountId = q.get('accountId');
    const status = q.get('status');
    const limit = Math.min(1000, Math.max(1, Number(q.get('limit')) || 200));
    const rows = await prisma.bankTransaction.findMany({
      where: txnListWhere(userId, { accountId: accountId ? Number(accountId) : null, status, hidePersonal: q.get('hidePersonal') === '1' }),
      orderBy: [{ postedDate: 'desc' }, { id: 'desc' }],
      take: limit,
      include: { account: { select: { name: true, creditCardId: true, ledgerAccountId: true } }, links: true },
    });
    return Response.json(rows.map(r => {
      let suggestion: unknown = null;
      try { suggestion = r.suggestion ? JSON.parse(r.suggestion) : null; } catch { /* ignore */ }
      return {
        id: r.id, accountId: r.bankAccountId, accountName: r.account.name, postedDate: r.postedDate, amountCents: r.amountCents,
        description: r.description, pending: r.pending, source: r.source, matchStatus: r.matchStatus,
        mapped: r.account.creditCardId != null || r.account.ledgerAccountId != null,
        depositable: r.account.ledgerAccountId != null && r.account.creditCardId == null,
        links: r.links.map(l => ({ id: l.id, kind: l.kind, refId: l.refId, amountCents: l.amountCents, note: l.note, matchedBy: l.matchedBy })), suggestion,
      };
    }));
  });
}
