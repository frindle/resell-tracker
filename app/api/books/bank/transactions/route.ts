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
    const parse = (s: string | null): { kind?: string; txnId?: number } | null => {
      try { return s ? JSON.parse(s) : null; } catch { return null; }
    };
    // The other row of a transfer or a charge-and-refund pair, by account and date (its id means nothing to the user).
    const PEER_LINKS = new Set(['transfer', 'reversal_pair']);
    const peerIds = new Set<number>();
    for (const r of rows) {
      const sg = parse(r.suggestion);
      if ((sg?.kind === 'transfer' || sg?.kind === 'pair') && typeof sg.txnId === 'number') peerIds.add(sg.txnId);
      for (const l of r.links) if (PEER_LINKS.has(l.kind) && l.refId) peerIds.add(l.refId);
    }
    const peerRows = peerIds.size === 0 ? [] : await prisma.bankTransaction.findMany({
      where: { userId, id: { in: [...peerIds] } }, select: { id: true, postedDate: true, account: { select: { name: true } } },
    });
    const peerOf = new Map(peerRows.map(p => [p.id, { accountName: p.account.name, postedDate: p.postedDate }]));
    return Response.json(rows.map(r => {
      const suggestion: unknown = parse(r.suggestion);
      const peers: Record<number, { accountName: string; postedDate: string }> = {};
      const sg = suggestion as { kind?: string; txnId?: number } | null;
      if (typeof sg?.txnId === 'number' && peerOf.has(sg.txnId)) peers[sg.txnId] = peerOf.get(sg.txnId)!;
      for (const l of r.links) if (PEER_LINKS.has(l.kind) && peerOf.has(l.refId)) peers[l.refId] = peerOf.get(l.refId)!;
      return {
        id: r.id, accountId: r.bankAccountId, accountName: r.account.name, postedDate: r.postedDate, amountCents: r.amountCents,
        description: r.description, pending: r.pending, source: r.source, matchStatus: r.matchStatus,
        mapped: r.account.creditCardId != null || r.account.ledgerAccountId != null,
        depositable: r.account.ledgerAccountId != null && r.account.creditCardId == null,
        links: r.links.map(l => ({ id: l.id, kind: l.kind, refId: l.refId, amountCents: l.amountCents, note: l.note, matchedBy: l.matchedBy })), suggestion, peers,
      };
    }));
  });
}
