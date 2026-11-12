import { NextRequest } from 'next/server';
import { withBooks } from '@/lib/books/api';
import { booksEnabled, getGoLive, setBooksEnabled } from '@/lib/books/service';
import { upsertSetting } from '@/lib/db';
import { DAY_RE } from '@/lib/books/dates';

export async function GET() {
  return withBooks(async userId => Response.json({
    enabled: await booksEnabled(userId),
    goLive: await getGoLive(userId),
    tallyConfigured: !!process.env.BLOOM_LEDGER_URL,
  }), { allowDisabled: true });
}

export async function POST(req: NextRequest) {
  return withBooks(async userId => {
    const body = await req.json();
    if (typeof body.goLive === 'string') {
      if (!DAY_RE.test(body.goLive)) return Response.json({ error: 'goLive must be YYYY-MM-DD' }, { status: 400 });
      await upsertSetting(userId, 'accounting.goLive', body.goLive);
    }
    if (typeof body.enabled === 'boolean') await setBooksEnabled(userId, body.enabled);
    return Response.json({ enabled: await booksEnabled(userId), goLive: await getGoLive(userId) });
  }, { allowDisabled: true });
}
