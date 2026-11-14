// DB glue for deposit shortfalls, payee aliases and the Darkbloom view (Books P3 step 3c). Prisma only: the lock gate
// imports this, so it must not pull in the books service.
import { prisma } from '../../db';
import { payeeToken } from '../match.ts';
import { openDepositShortfalls, type DepositShortfall } from '../payoutReview.ts';
import { lastDayOfMonth } from '../dates.ts';

/** Remember which buyer a deposit description belongs to. The latest accepted deposit wins a token. */
export async function learnAlias(userId: number, description: string, buyerId: number | null | undefined) {
  const token = payeeToken(description);
  if (!token || buyerId == null) return;
  await prisma.payeeAlias.upsert({ where: { userId_token: { userId, token } }, create: { userId, buyerId, token }, update: { buyerId } });
}

export async function loadAliases(userId: number): Promise<Map<string, number>> {
  return new Map((await prisma.payeeAlias.findMany({ where: { userId } })).map(a => [a.token, a.buyerId]));
}

export type OpenShortfall = DepositShortfall & { postedDate: string; description: string; amountCents: number; matchedBy: string };

/** Deposits with an unclassified shortfall, optionally only those dated in `month` (YYYY-MM). */
export async function listOpenShortfalls(userId: number, month?: string): Promise<OpenShortfall[]> {
  const links = await prisma.bankMatch.findMany({ where: { userId, kind: { in: ['payout', 'payout_shortfall'] } } });
  const open = openDepositShortfalls(links.map(l => ({ txnId: l.txnId, kind: l.kind, refId: l.refId, amountCents: l.amountCents, note: l.note })));
  if (open.length === 0) return [];
  const rows = await prisma.bankTransaction.findMany({
    where: { userId, id: { in: open.map(o => o.txnId) }, ...(month ? { postedDate: { gte: `${month}-01`, lte: lastDayOfMonth(month) } } : {}) },
  });
  const by = new Map(rows.map(r => [r.id, r]));
  const by2 = new Map(links.filter(l => l.kind === 'payout').map(l => [l.txnId, l.matchedBy]));
  return open.filter(o => by.has(o.txnId)).map(o => ({ ...o, postedDate: by.get(o.txnId)!.postedDate, description: by.get(o.txnId)!.description, amountCents: by.get(o.txnId)!.amountCents, matchedBy: by2.get(o.txnId) ?? 'user' }));
}

export type DarkbloomMonth = { month: string; earnedCents: number; receivedCents: number; pieces: number; owedCents: number };

/**
 * Darkbloom balance (1500) against payouts received, by month. Earned: what the tally and the opening put on 1500 (everything
 * but bank rows). Received: `darkbloom` links on posted rows. Owed: running earned less received, i.e. the 1500 balance.
 */
export async function darkbloomView(userId: number, goLive: string): Promise<{ months: DarkbloomMonth[]; balanceCents: number }> {
  const acct = await prisma.ledgerAccount.findFirst({ where: { userId, systemKey: 'darkbloom_balance' }, select: { id: true } });
  const earned = new Map<string, number>(), received = new Map<string, number>(), pieces = new Map<string, number>();
  if (acct) {
    const lines = await prisma.journalLine.findMany({ where: { accountId: acct.id, entry: { userId, NOT: { source: 'bank' } } }, select: { amountCents: true, entry: { select: { date: true } } } });
    for (const l of lines) { const m = l.entry.date.slice(0, 7); earned.set(m, (earned.get(m) ?? 0) + l.amountCents); }
  }
  const links = await prisma.bankMatch.findMany({ where: { userId, kind: 'darkbloom' }, include: { txn: { select: { postedDate: true, pending: true } } } });
  for (const l of links) {
    if (l.txn.pending || l.txn.postedDate < goLive) continue;
    const m = l.txn.postedDate.slice(0, 7);
    received.set(m, (received.get(m) ?? 0) + l.amountCents);
    pieces.set(m, (pieces.get(m) ?? 0) + 1);
  }
  const keys = [...new Set([...earned.keys(), ...received.keys()])].sort();
  let run = 0;
  const months = keys.map(month => {
    const e = earned.get(month) ?? 0, r = received.get(month) ?? 0;
    run += e - r;
    return { month, earnedCents: e, receivedCents: r, pieces: pieces.get(month) ?? 0, owedCents: run };
  });
  return { months, balanceCents: run };
}
