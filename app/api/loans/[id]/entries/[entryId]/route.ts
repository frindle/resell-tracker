import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { parseEntryBody, mergeEntryPatch } from '@/lib/loans';
import { NextRequest } from 'next/server';

// Edit one entry: merge onto the stored row, validate like create. Kind and schedule row stay fixed.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string; entryId: string }> }) {
  try {
    const userId = await getSessionUserId();
    const { id, entryId } = await params;
    const entry = await prisma.loanEntry.findFirst({
      where: { id: parseInt(entryId), loanId: parseInt(id), loan: { userId: userId ?? null } },
      include: { loan: { select: { kind: true } } },
    });
    if (!entry) return Response.json({ error: 'entry not found' }, { status: 404 });
    const patch = await req.json();
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return Response.json({ error: 'invalid body' }, { status: 400 });
    const parsed = parseEntryBody(mergeEntryPatch(entry, patch), entry.loan.kind);
    if ('error' in parsed) return Response.json({ error: parsed.error }, { status: 400 });
    const updated = await prisma.loanEntry.update({ where: { id: entry.id }, data: parsed.ok });
    return Response.json(updated);
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}

// Deleting a recorded payment puts the scheduled one back.
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string; entryId: string }> }) {
  try {
    const userId = await getSessionUserId();
    const { id, entryId } = await params;
    const r = await prisma.loanEntry.deleteMany({
      where: { id: parseInt(entryId), loanId: parseInt(id), loan: { userId: userId ?? null } },
    });
    if (r.count === 0) return Response.json({ error: 'entry not found' }, { status: 404 });
    return new Response(null, { status: 204 });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
