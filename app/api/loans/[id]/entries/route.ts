import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { parseEntryBody } from '@/lib/loans';
import { NextRequest } from 'next/server';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = await getSessionUserId();
    const { id } = await params;
    const loan = await prisma.loan.findFirst({ where: { id: parseInt(id), userId: userId ?? null } });
    if (!loan) return Response.json({ error: 'loan not found' }, { status: 404 });
    const parsed = parseEntryBody(await req.json(), loan.kind);
    if ('error' in parsed) return Response.json({ error: parsed.error }, { status: 400 });
    // One recorded payment per schedule row: entering it again replaces the old one.
    if (parsed.ok.kind === 'payment') {
      await prisma.loanEntry.deleteMany({ where: { loanId: loan.id, kind: 'payment', periodIndex: parsed.ok.periodIndex } });
    }
    const entry = await prisma.loanEntry.create({ data: { ...parsed.ok, loanId: loan.id } });
    return Response.json(entry, { status: 201 });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
