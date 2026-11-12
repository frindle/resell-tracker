import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { withBooks } from '@/lib/books/api';
import { runReconcile } from '@/lib/books/service';

/** Void a cost entry (the journal gets a reversal; nothing is deleted). Body: { void: true }. */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withBooks(async userId => {
    const { id } = await params;
    const body = await req.json();
    const row = await prisma.costEntry.findFirst({ where: { id: Number(id), userId } });
    if (!row) return Response.json({ error: 'not found' }, { status: 404 });
    if (body.void !== true) return Response.json({ error: 'only { void: true } is supported' }, { status: 400 });
    if (!row.voidedAt) {
      await prisma.costEntry.update({ where: { id: row.id }, data: { voidedAt: new Date() } });
      await prisma.auditLog.create({ data: { userId, actor: `user:${userId}`, action: 'void', entity: 'CostEntry', entityId: String(row.id), before: JSON.stringify(row) } });
      await runReconcile(userId);
    }
    return Response.json({ ok: true });
  });
}
