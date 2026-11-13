import { NextRequest } from 'next/server';
import { withBooks } from '@/lib/books/api';
import { PrismaStore } from '@/lib/books/prismaStore';
import { applyOpening, getGoLive, loadOrders, readOpeningInput } from '@/lib/books/service';
import { buildOpening, bankAccountIds, type OpeningInput } from '@/lib/books/opening';
import { toCents } from '@/lib/books/money';
import { prisma } from '@/lib/db';

/** Current inputs plus a preview of what the opening entry would carry (inventory, receivables). */
export async function GET() {
  return withBooks(async userId => {
    const store = new PrismaStore();
    const goLive = await getGoLive(userId);
    const orders = await loadOrders(userId);
    const input = await readOpeningInput(userId);
    const events = await store.eventDates(orders.map(o => o.id));
    const built = buildOpening(orders, input, { goLive, now: new Date(), events });
    const [accounts, cards, loans] = await Promise.all([
      store.listAccounts(userId),
      prisma.creditCard.findMany({ where: { userId }, select: { id: true, name: true } }),
      prisma.loan.findMany({ where: { userId }, select: { id: true, name: true } }),
    ]);
    return Response.json({
      goLive, input,
      banks: accounts.filter(a => /^10\d\d$/.test(a.code)),
      cards, loans,
      preview: { inventoryCents: built.inventoryCents, receivableCents: built.receivableCents },
    });
  });
}

const dollarsToCents = (v: unknown) => (v == null || v === '' ? 0 : (toCents(Number(v)) ?? 0));

/** Body amounts are dollars. Re-running replaces the previous opening entry (reversal + new entry). */
export async function POST(req: NextRequest) {
  return withBooks(async userId => {
    const b = await req.json();
    const input: OpeningInput = {
      banks: (b.banks ?? []).map((x: { accountId: number; amount: unknown }) => ({ accountId: Number(x.accountId), cents: dollarsToCents(x.amount) })),
      cards: (b.cards ?? []).map((x: { cardId: number; amount: unknown }) => ({ cardId: Number(x.cardId), cents: dollarsToCents(x.amount) })),
      loans: (b.loans ?? []).map((x: { loanId: number; amount: unknown }) => ({ loanId: Number(x.loanId), cents: dollarsToCents(x.amount) })),
      darkbloomCents: dollarsToCents(b.darkbloom),
      undepositedCents: dollarsToCents(b.undeposited),
    };
    const accts = bankAccountIds(await new PrismaStore().listAccounts(userId));
    if (input.banks.some(x => !accts.has(x.accountId))) return Response.json({ error: 'unknown bank account' }, { status: 400 });
    const ownedIds = async (rows: Promise<{ id: number }[]>) => new Set((await rows).map(r => r.id));
    const [cardIds, loanIds] = await Promise.all([
      ownedIds(prisma.creditCard.findMany({ where: { userId }, select: { id: true } })),
      ownedIds(prisma.loan.findMany({ where: { userId }, select: { id: true } })),
    ]);
    if (input.cards.some(x => !cardIds.has(x.cardId))) return Response.json({ error: 'unknown card' }, { status: 400 });
    if (input.loans.some(x => !loanIds.has(x.loanId))) return Response.json({ error: 'unknown loan' }, { status: 400 });
    const before = await readOpeningInput(userId);
    const result = await applyOpening(userId, input, new Date(), {
      userId, actor: `user:${userId}`, action: 'opening', entity: 'Opening', entityId: 'opening', before: JSON.stringify(before), after: JSON.stringify(input),
    });
    return Response.json(result);
  });
}
