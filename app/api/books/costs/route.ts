import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { withBooks } from '@/lib/books/api';
import { runReconcile } from '@/lib/books/service';
import { toCents } from '@/lib/books/money';
import { DAY_RE } from '@/lib/books/dates';
import { COST_CATEGORIES } from '@/lib/books/chart';
import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { sniffUpload, uploadProblem, MAX_UPLOAD_BYTES } from '@/lib/uploadSniff';
import { randomUUID } from 'crypto';

const COSTS_DIR = '/data/files/costs';

export async function GET() {
  return withBooks(async userId => Response.json({
    categories: COST_CATEGORIES,
    costs: await prisma.costEntry.findMany({ where: { userId }, orderBy: [{ date: 'desc' }, { id: 'desc' }], include: { paidFromAccount: { select: { name: true } } } }),
  }));
}

/** JSON or multipart (fields + optional `file`). `amount` is dollars; a cost entry is posted by the reconciler right after. */
export async function POST(req: NextRequest) {
  return withBooks(async userId => {
    let f: Record<string, unknown>;
    let file: File | null = null;
    if ((req.headers.get('content-type') ?? '').includes('multipart/form-data')) {
      const fd = await req.formData();
      f = Object.fromEntries([...fd.entries()].filter(([, v]) => typeof v === 'string'));
      const x = fd.get('file');
      file = x instanceof File && x.size > 0 ? x : null;
    } else f = await req.json();

    const amountCents = toCents(Number(f.amount));
    const pct = f.businessPct == null || f.businessPct === '' ? 100 : Number(f.businessPct);
    const category = String(f.category ?? '');
    const date = String(f.date ?? '');
    const business = f.business === 'shared' ? 'shared' : 'resell';
    const paidFromAccountId = Number(f.paidFromAccountId);
    if (amountCents == null || amountCents <= 0) return Response.json({ error: 'amount must be positive' }, { status: 400 });
    if (!Number.isInteger(pct) || pct < 0 || pct > 100) return Response.json({ error: 'businessPct must be 0-100' }, { status: 400 });
    if (!COST_CATEGORIES.includes(category)) return Response.json({ error: 'unknown category' }, { status: 400 });
    if (!DAY_RE.test(date)) return Response.json({ error: 'date must be YYYY-MM-DD' }, { status: 400 });
    const acct = await prisma.ledgerAccount.findFirst({ where: { id: paidFromAccountId, userId } });
    if (!acct) return Response.json({ error: 'paid-from account not found' }, { status: 400 });

    let bytes: Buffer | null = null;
    if (file) {
      if (file.size > MAX_UPLOAD_BYTES) return Response.json({ error: `file is larger than ${MAX_UPLOAD_BYTES / 1024 / 1024} MB` }, { status: 400 });
      bytes = Buffer.from(await file.arrayBuffer());
      const bad = uploadProblem(bytes);
      if (bad) return Response.json({ error: bad }, { status: 400 });
    }

    const row = await prisma.costEntry.create({
      data: {
        userId, business, date, amountCents, category, businessPct: pct, paidFromAccountId,
        vendor: f.vendor ? String(f.vendor) : null, purpose: f.purpose ? String(f.purpose) : null, note: f.note ? String(f.note) : null,
      },
    });
    if (file && bytes) {
      const type = sniffUpload(bytes)!; // checked above; the stored name and type come from the bytes
      const filename = `${randomUUID()}${type.ext}`;
      const dir = join(COSTS_DIR, String(row.id));
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, filename), bytes);
      await prisma.costEntry.update({ where: { id: row.id }, data: { attachmentFile: filename, attachmentName: file.name, attachmentMime: type.mime } });
    }
    await prisma.auditLog.create({
      data: { userId, actor: `user:${userId}`, action: 'create', entity: 'CostEntry', entityId: String(row.id), after: JSON.stringify({ ...row, attachmentName: file?.name ?? null }) },
    });
    await runReconcile(userId);
    return Response.json(await prisma.costEntry.findUnique({ where: { id: row.id } }), { status: 201 });
  });
}
