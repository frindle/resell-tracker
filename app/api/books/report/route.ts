import { NextRequest } from 'next/server';
import { withBooks } from '@/lib/books/api';
import { PrismaStore } from '@/lib/books/prismaStore';
import { pnlByMonth, trialBalance } from '@/lib/books/reports';
import { DAY_RE } from '@/lib/books/dates';

export async function GET(req: NextRequest) {
  return withBooks(async userId => {
    const sp = req.nextUrl.searchParams;
    const from = sp.get('from') ?? undefined;
    const to = sp.get('to') ?? undefined;
    if ((from && !DAY_RE.test(from)) || (to && !DAY_RE.test(to))) return Response.json({ error: 'bad date' }, { status: 400 });
    const lines = await new PrismaStore().ledgerLines(userId, { from, to });
    return Response.json({
      disclaimer: 'Bookkeeping estimate for your records. Not tax advice.',
      trial: trialBalance(lines),
      pnl: pnlByMonth(lines),
    });
  });
}
