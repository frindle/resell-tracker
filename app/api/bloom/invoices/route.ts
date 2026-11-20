import { prisma } from '@/lib/db';
import { bloomUser } from '@/lib/bloomRequest';

export async function GET() {
  try {
    const who = await bloomUser();
    if ('error' in who) return Response.json({ error: who.error }, { status: who.status });
    const userId = who.userId;
    const rows = await prisma.bloomInvoice.findMany({
      where: { userId }, orderBy: { month: 'desc' },
      select: { month: true, grossCents: true, otherIncomeCents: true, feesCents: true, costsCents: true, netCents: true, fetchedAt: true, updatedAt: true },
    });
    return Response.json({ configured: !!process.env.BLOOM_LEDGER_URL, invoices: rows });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
