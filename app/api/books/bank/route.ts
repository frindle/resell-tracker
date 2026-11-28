import { withBooks } from '@/lib/books/api';
import { connectionStatus } from '@/lib/books/bank/service';
import { prisma } from '@/lib/db';
import { closedLast, leftoverCents, leftoverMessage, isPostClose } from '@/lib/books/bank/closed';

/** Connection status, accounts (with links) and the cards / ledger accounts they can link to. No secrets. */
export async function GET() {
  return withBooks(async userId => {
    const [status, accounts, cards, ledger, counts] = await Promise.all([
      connectionStatus(userId),
      prisma.bankAccount.findMany({ where: { userId }, orderBy: { name: 'asc' } }),
      prisma.creditCard.findMany({ where: { userId }, select: { id: true, name: true, last4: true } }),
      prisma.ledgerAccount.findMany({ where: { userId, active: true, type: { in: ['asset', 'liability'] } }, select: { id: true, code: true, name: true }, orderBy: { code: 'asc' } }),
      prisma.bankTransaction.groupBy({ by: ['bankAccountId', 'matchStatus'], where: { userId }, _count: true }),
    ]);
    // A card or ledger account whose bank account is closed is marked closed in the pickers (it still resolves for old links).
    const closedBy = (key: 'creditCardId' | 'ledgerAccountId', id: number) => accounts.find(a => a[key] === id && a.closedOn)?.closedOn ?? null;
    const closedAccts = accounts.filter(a => a.closedOn);
    const closedRows = closedAccts.length ? await prisma.bankTransaction.findMany({ where: { userId, bankAccountId: { in: closedAccts.map(a => a.id) } }, select: { bankAccountId: true, postedDate: true, amountCents: true, pending: true } }) : [];
    const closedInfo = (a: (typeof accounts)[number]) => {
      const rows = closedRows.filter(r => r.bankAccountId === a.id);
      const left = leftoverCents(a.balanceCents, a.balanceDate, rows, a.closedOn);
      return { leftoverCents: left, leftoverMessage: leftoverMessage(left), postCloseRows: rows.filter(r => isPostClose(a.closedOn, r.postedDate)).length, lastPostedDate: rows.filter(r => !r.pending).map(r => r.postedDate).sort().pop() ?? null };
    };
    return Response.json({
      ...status,
      accounts: closedLast(accounts).map(a => ({
        id: a.id, name: a.name, orgName: a.orgName, kind: a.kind, last4: a.last4, currency: a.currency, provider: a.provider,
        creditCardId: a.creditCardId, ledgerAccountId: a.ledgerAccountId, balanceCents: a.balanceCents, balanceDate: a.balanceDate, hidden: a.hidden, closedOn: a.closedOn, ...(a.closedOn ? closedInfo(a) : {}),
        counts: Object.fromEntries(counts.filter(c => c.bankAccountId === a.id).map(c => [c.matchStatus, c._count])),
      })),
      cards: closedLast(cards.map(c => ({ ...c, closedOn: closedBy('creditCardId', c.id) }))),
      ledger: closedLast(ledger.map(l => ({ ...l, closedOn: closedBy('ledgerAccountId', l.id) }))),
    });
  });
}
