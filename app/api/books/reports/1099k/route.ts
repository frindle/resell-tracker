import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { withBooks } from '@/lib/books/api';
import { toCents } from '@/lib/books/money';

// The only write in the reports area: the 1099-K amounts the user types in. They never touch the ledger.
const KEY_RE = /^(buyer:\d+|ar_unassigned|darkbloom)$/;

/** Body: { year, payerName, payerKeys: string[], amount (dollars), transactions? , note? }. Saving the same year and payer again replaces it. */
export async function POST(req: NextRequest) {
  return withBooks(async userId => {
    const b = await req.json();
    const year = Number(b.year);
    const payerName = String(b.payerName ?? '').trim();
    const keys: string[] = Array.isArray(b.payerKeys) ? b.payerKeys.map(String) : [];
    const amountCents = toCents(Number(b.amount));
    const tx = b.transactions == null || b.transactions === '' ? null : Number(b.transactions);
    if (!Number.isInteger(year) || year < 2000 || year > 2100) return Response.json({ error: 'year must be a 4-digit year' }, { status: 400 });
    if (!payerName || payerName.length > 120) return Response.json({ error: 'payer name is required' }, { status: 400 });
    if (keys.length === 0 || !keys.every(k => KEY_RE.test(k))) return Response.json({ error: 'pick at least one payer from the list' }, { status: 400 });
    if (amountCents == null || amountCents < 0) return Response.json({ error: 'amount must be zero or more' }, { status: 400 });
    if (tx != null && (!Number.isInteger(tx) || tx < 0)) return Response.json({ error: 'transactions must be a whole number' }, { status: 400 });
    const data = { payerKeys: [...new Set(keys)].join(','), amountCents, transactions: tx, note: b.note ? String(b.note).slice(0, 500) : null };
    const before = await prisma.form1099K.findUnique({ where: { userId_year_payerName: { userId, year, payerName } } });
    const row = await prisma.form1099K.upsert({
      where: { userId_year_payerName: { userId, year, payerName } },
      create: { userId, year, payerName, ...data }, update: data,
    });
    await prisma.auditLog.create({
      data: { userId, actor: `user:${userId}`, action: before ? 'update' : 'create', entity: 'Form1099K', entityId: String(row.id), before: before ? JSON.stringify(before) : null, after: JSON.stringify(row) },
    });
    return Response.json(row, { status: before ? 200 : 201 });
  });
}

export async function DELETE(req: NextRequest) {
  return withBooks(async userId => {
    const id = Number(req.nextUrl.searchParams.get('id'));
    if (!Number.isInteger(id) || id <= 0) return Response.json({ error: 'id must be a positive whole number' }, { status: 400 });
    const row = await prisma.form1099K.findFirst({ where: { id, userId } });
    if (!row) return Response.json({ error: 'not found' }, { status: 404 });
    await prisma.$transaction([
      prisma.form1099K.delete({ where: { id: row.id } }),
      prisma.auditLog.create({ data: { userId, actor: `user:${userId}`, action: 'delete', entity: 'Form1099K', entityId: String(row.id), before: JSON.stringify(row) } }),
    ]);
    return Response.json({ ok: true });
  });
}
