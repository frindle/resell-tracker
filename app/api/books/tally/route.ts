import { withBooks } from '@/lib/books/api';
import { runTallySync } from '@/lib/books/service';
import { prisma } from '@/lib/db';
import { tallyNotComputed, type TallyMonth } from '@/lib/books/tally';

export async function GET() {
  return withBooks(async userId => {
    const rows = await prisma.darkbloomTally.findMany({ where: { userId }, orderBy: { month: 'asc' }, select: { month: true, hash: true, postedEntryId: true, fetchedAt: true, payload: true } });
    return Response.json({
      configured: !!process.env.BLOOM_LEDGER_URL,
      months: rows.map(r => {
        let withdrawable: number | null = null;
        let notComputed: { machine: string | null; column: string }[] = [];
        try {
          const p = JSON.parse(r.payload) as TallyMonth;
          withdrawable = p?.balances?.withdrawable_cents ?? null;
          notComputed = tallyNotComputed(p);
        } catch { /* ignore */ }
        return { month: r.month, hash: r.hash, postedEntryId: r.postedEntryId, fetchedAt: r.fetchedAt, withdrawableCents: withdrawable, notComputed };
      }),
    });
  });
}

export async function POST() {
  return withBooks(async userId => Response.json(await runTallySync(userId)));
}
