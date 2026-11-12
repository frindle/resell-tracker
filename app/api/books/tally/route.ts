import { withBooks } from '@/lib/books/api';
import { runTallySync } from '@/lib/books/service';
import { prisma } from '@/lib/db';

export async function GET() {
  return withBooks(async userId => {
    const rows = await prisma.darkbloomTally.findMany({ where: { userId }, orderBy: { month: 'asc' }, select: { month: true, hash: true, postedEntryId: true, fetchedAt: true, payload: true } });
    return Response.json({
      configured: !!process.env.BLOOM_LEDGER_URL,
      months: rows.map(r => {
        let withdrawable: number | null = null;
        try { withdrawable = JSON.parse(r.payload)?.balances?.withdrawable_cents ?? null; } catch { /* ignore */ }
        return { month: r.month, hash: r.hash, postedEntryId: r.postedEntryId, fetchedAt: r.fetchedAt, withdrawableCents: withdrawable };
      }),
    });
  });
}

export async function POST() {
  return withBooks(async userId => Response.json(await runTallySync(userId)));
}
