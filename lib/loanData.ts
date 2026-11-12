import { prisma } from '@/lib/db';
import type { LoanLite } from '@/lib/loans';

/** The signed-in user's loans (same scoping as cards) with their entries. */
export async function loadLoans(userId: number | null): Promise<LoanLite[]> {
  return prisma.loan.findMany({
    where: { userId: userId ?? null },
    include: { entries: { orderBy: { postedAt: 'asc' } } },
  });
}
