import { NextRequest } from 'next/server';
import { withBooks } from '@/lib/books/api';
import { prisma } from '@/lib/db';
import { txnListWhere } from '@/lib/books/bank/service';

/** ?accountId=&status=unmatched|suggested|matched|ignored&hidePersonal=1&hidePending=1&limit= (default 200, max 1000). Newest first. */
export async function GET(req: NextRequest) {
  return withBooks(async userId => {
    const q = req.nextUrl.searchParams;
    const accountId = q.get('accountId');
    const status = q.get('status');
    const limit = Math.min(1000, Math.max(1, Number(q.get('limit')) || 200));
    const rows = await prisma.bankTransaction.findMany({
      where: txnListWhere(userId, { accountId: accountId ? Number(accountId) : null, status, hidePersonal: q.get('hidePersonal') === '1', hidePending: q.get('hidePending') === '1' }),
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
    // The orders a suggestion or a link names, so the row can say which order it is (shop, number, date, items, total).
    const ORDER_LINKS = new Set(['order_charge', 'cashback', 'payout', 'payout_shortfall']);
    const orderIdsOf = (sg: unknown, links: { kind: string; refId: number }[]): number[] => {
      const ids: unknown[] = [];
      const g = sg as Record<string, unknown> | null;
      if (g?.kind === 'order' && Array.isArray(g.orderIds)) ids.push(...g.orderIds);
      if (g?.kind === 'split') ids.push(g.orderId);
      if (g?.kind === 'refund' && Array.isArray(g.returns)) for (const r of g.returns as { orderId?: unknown }[]) ids.push(r.orderId);
      if (g?.kind === 'cashback' && Array.isArray(g.options)) for (const o of g.options as { units?: { orderId?: unknown }[] }[]) for (const u of o.units ?? []) ids.push(u.orderId);
      if (g?.kind === 'deposit' && Array.isArray(g.options)) for (const o of g.options as { parts?: { orderId?: unknown }[] }[]) for (const p of o.parts ?? []) ids.push(p.orderId);
      for (const l of links) if (ORDER_LINKS.has(l.kind)) ids.push(l.refId);
      return [...new Set(ids.filter((x): x is number => typeof x === 'number' && x > 0))];
    };
    const allOrderIds = new Set<number>();
    for (const r of rows) for (const id of orderIdsOf(parse(r.suggestion), r.links)) allOrderIds.add(id);
    const orderRows = allOrderIds.size === 0 ? [] : await prisma.order.findMany({
      where: { userId, id: { in: [...allOrderIds] } },
      select: { id: true, platform: true, orderNumber: true, orderDate: true, itemDescription: true, cost: true, shippingCost: true, insuranceCost: true, buyer: { select: { name: true } } },
    });
    const orderOf = new Map(orderRows.map(o => [o.id, {
      platform: o.platform, orderNumber: o.orderNumber, orderDate: o.orderDate.toISOString().slice(0, 10),
      items: o.itemDescription ? o.itemDescription.slice(0, 120) : null, buyer: o.buyer?.name ?? null,
      totalCents: Math.round((o.cost + o.shippingCost + o.insuranceCost) * 100),
    }]));
    return Response.json(rows.map(r => {
      const suggestion: unknown = parse(r.suggestion);
      const peers: Record<number, { accountName: string; postedDate: string }> = {};
      const sg = suggestion as { kind?: string; txnId?: number } | null;
      if (typeof sg?.txnId === 'number' && peerOf.has(sg.txnId)) peers[sg.txnId] = peerOf.get(sg.txnId)!;
      for (const l of r.links) if (PEER_LINKS.has(l.kind) && peerOf.has(l.refId)) peers[l.refId] = peerOf.get(l.refId)!;
      const orders: Record<number, NonNullable<ReturnType<typeof orderOf.get>>> = {};
      for (const id of orderIdsOf(suggestion, r.links)) { const o = orderOf.get(id); if (o) orders[id] = o; }
      return {
        id: r.id, accountId: r.bankAccountId, accountName: r.account.name, postedDate: r.postedDate, amountCents: r.amountCents,
        description: r.description, pending: r.pending, source: r.source, matchStatus: r.matchStatus,
        mapped: r.account.creditCardId != null || r.account.ledgerAccountId != null,
        depositable: r.account.ledgerAccountId != null && r.account.creditCardId == null,
        links: r.links.map(l => ({ id: l.id, kind: l.kind, refId: l.refId, amountCents: l.amountCents, note: l.note, matchedBy: l.matchedBy })), suggestion, peers, orders,
      };
    }));
  });
}
