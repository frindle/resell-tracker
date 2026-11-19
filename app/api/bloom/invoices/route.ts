import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';

export async function GET() {
  try {
    const userId = await getSessionUserId();
    if (userId == null) return Response.json({ error: 'sign in required' }, { status: 401 });
    const rows = await prisma.bloomInvoice.findMany({
      where: { userId }, orderBy: { month: 'desc' },
      select: { month: true, grossCents: true, otherIncomeCents: true, feesCents: true, costsCents: true, netCents: true, fetchedAt: true, updatedAt: true },
    });
    return Response.json({ configured: !!process.env.BLOOM_LEDGER_URL, invoices: rows });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
