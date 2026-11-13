import { NextRequest } from 'next/server';
import { withBooks } from '@/lib/books/api';
import { booksEnabled, getGoLive, setBooksEnabled } from '@/lib/books/service';
import { bankPostingEnabled } from '@/lib/books/bank/posting';
import { prisma, upsertSetting } from '@/lib/db';
import { DAY_RE } from '@/lib/books/dates';

export async function GET() {
  return withBooks(async userId => Response.json({
    enabled: await booksEnabled(userId),
    goLive: await getGoLive(userId),
    tallyConfigured: !!process.env.BLOOM_LEDGER_URL,
    bankPosting: await bankPostingEnabled(userId),
  }), { allowDisabled: true });
}

export async function POST(req: NextRequest) {
  return withBooks(async userId => {
    const body = await req.json();
    if (typeof body.goLive === 'string') {
      if (!DAY_RE.test(body.goLive)) return Response.json({ error: 'goLive must be YYYY-MM-DD' }, { status: 400 });
      const current = await getGoLive(userId);
      if (body.goLive !== current) {
        // Read-only while the books are on (every posted entry depends on it); turn them off to change it.
        if (await booksEnabled(userId)) return Response.json({ error: 'go-live date is locked while books are on; turn them off to change it' }, { status: 409 });
        await upsertSetting(userId, 'accounting.goLive', body.goLive);
        await prisma.auditLog.create({
          data: { userId, actor: `user:${userId}`, action: 'golive', entity: 'Setting', entityId: 'accounting.goLive', before: JSON.stringify({ goLive: current }), after: JSON.stringify({ goLive: body.goLive }) },
        });
      }
    }
    if (typeof body.enabled === 'boolean') await setBooksEnabled(userId, body.enabled);
    if (typeof body.bankPosting === 'boolean') {
      const before = await bankPostingEnabled(userId);
      if (before !== body.bankPosting) {
        await upsertSetting(userId, 'accounting.bankPosting', body.bankPosting ? 'true' : 'false');
        await prisma.auditLog.create({
          data: { userId, actor: `user:${userId}`, action: 'bank_posting', entity: 'Setting', entityId: 'accounting.bankPosting', before: JSON.stringify({ on: before }), after: JSON.stringify({ on: body.bankPosting }) },
        });
      }
    }
    return Response.json({ enabled: await booksEnabled(userId), goLive: await getGoLive(userId), bankPosting: await bankPostingEnabled(userId) });
  }, { allowDisabled: true });
}
