import { NextRequest } from 'next/server';
import { nextBankCode } from '@/lib/books/chart';
import { prisma } from '@/lib/db';
import { withBooks } from '@/lib/books/api';
import { PrismaStore } from '@/lib/books/prismaStore';

export async function GET() {
  return withBooks(async userId => Response.json(await new PrismaStore().listAccounts(userId)));
}

/** Create a bank / cash account (codes 1000-1099). */
export async function POST(req: NextRequest) {
  return withBooks(async userId => {
    const { name } = await req.json();
    if (typeof name !== 'string' || !name.trim()) return Response.json({ error: 'name required' }, { status: 400 });
    // The unique index on (userId, code) for bank accounts is the real guard (two Prisma clients, so no in-process lock
    // is enough); on a conflict re-read the used codes and try the next free one.
    for (let attempt = 0; attempt < 5; attempt++) {
      const banks = await prisma.ledgerAccount.findMany({ where: { userId, code: { startsWith: '10' }, creditCardId: null }, select: { code: true } });
      const used = new Set(banks.map(b => b.code));
      let code: string;
      try { code = nextBankCode(used); } catch (e) { return Response.json({ error: (e as Error).message }, { status: 409 }); }
      try {
        const a = await prisma.ledgerAccount.create({ data: { userId, code, name: name.trim(), type: 'asset', business: 'shared' } });
        return Response.json(a, { status: 201 });
      } catch (e) {
        if ((e as { code?: string }).code !== 'P2002') throw e;
      }
    }
    return Response.json({ error: 'could not allocate a bank account code, try again' }, { status: 409 });
  });
}
