import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { withBooks } from '@/lib/books/api';
import { MONTH_RE } from '@/lib/books/dates';
import { getGoLive } from '@/lib/books/service';
import { lockGate, lockMonth } from '@/lib/books/bank/posting';

export async function GET() {
  return withBooks(async userId => Response.json(await prisma.periodLock.findMany({ where: { userId }, orderBy: { month: 'asc' } })));
}

/** ?month=YYYY-MM : would locking pass the gate? */
export async function PUT(req: NextRequest) {
  return withBooks(async userId => {
    const { month } = await req.json();
    if (typeof month !== 'string' || !MONTH_RE.test(month)) return Response.json({ error: 'month must be YYYY-MM' }, { status: 400 });
    return Response.json(await lockGate(userId, month, await getGoLive(userId)));
  });
}

/**
 * Body { month, force?, reason? }. A month whose mapped accounts do not all tie (or that still has open bank rows)
 * is refused with 409 and the gate, unless force is true with a reason, which is written to the audit log.
 */
export async function POST(req: NextRequest) {
  return withBooks(async userId => {
    const { month, force, reason } = await req.json();
    if (typeof month !== 'string' || !MONTH_RE.test(month)) return Response.json({ error: 'month must be YYYY-MM' }, { status: 400 });
    const r = await lockMonth(userId, month, await getGoLive(userId), { force: force === true, reason: typeof reason === 'string' ? reason : '' });
    if (!r.ok) return Response.json({ error: 'this month does not tie yet', gate: r.gate }, { status: 409 });
    return Response.json(r);
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
