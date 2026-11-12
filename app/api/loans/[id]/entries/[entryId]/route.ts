import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { NextRequest } from 'next/server';

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
