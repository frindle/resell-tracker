import { withBooks } from '@/lib/books/api';
import { connectionStatus } from '@/lib/books/bank/service';
import { prisma } from '@/lib/db';

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
    return Response.json({
      ...status,
      accounts: accounts.map(a => ({
        id: a.id, name: a.name, orgName: a.orgName, kind: a.kind, last4: a.last4, currency: a.currency, provider: a.provider,
        creditCardId: a.creditCardId, ledgerAccountId: a.ledgerAccountId, balanceCents: a.balanceCents, balanceDate: a.balanceDate,
        counts: Object.fromEntries(counts.filter(c => c.bankAccountId === a.id).map(c => [c.matchStatus, c._count])),
      })),
      cards, ledger,
    });
  });
}
