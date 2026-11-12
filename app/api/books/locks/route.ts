import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { withBooks } from '@/lib/books/api';
import { MONTH_RE } from '@/lib/books/dates';

export async function GET() {
  return withBooks(async userId => Response.json(await prisma.periodLock.findMany({ where: { userId }, orderBy: { month: 'asc' } })));
}

export async function POST(req: NextRequest) {
  return withBooks(async userId => {
    const { month } = await req.json();
    if (typeof month !== 'string' || !MONTH_RE.test(month)) return Response.json({ error: 'month must be YYYY-MM' }, { status: 400 });
    await prisma.periodLock.upsert({ where: { userId_month: { userId, month } }, create: { userId, month }, update: {} });
    await prisma.auditLog.create({ data: { userId, actor: `user:${userId}`, action: 'lock', entity: 'PeriodLock', entityId: month } });
    return Response.json({ ok: true });
  });
}

/** Unlocking is allowed but always audited. */
export async function DELETE(req: NextRequest) {
  return withBooks(async userId => {
    const { month, reason } = await req.json();
    if (typeof month !== 'string' || !MONTH_RE.test(month)) return Response.json({ error: 'month must be YYYY-MM' }, { status: 400 });
    const existing = await prisma.periodLock.findUnique({ where: { userId_month: { userId, month } } });
    if (!existing) return Response.json({ error: 'not locked' }, { status: 404 });
    await prisma.$transaction([
      prisma.periodLock.delete({ where: { userId_month: { userId, month } } }),
      prisma.auditLog.create({
        data: { userId, actor: `user:${userId}`, action: 'unlock', entity: 'PeriodLock', entityId: month, before: JSON.stringify(existing), after: typeof reason === 'string' ? JSON.stringify({ reason }) : null },
      }),
    ]);
    return Response.json({ ok: true });
  });
}
