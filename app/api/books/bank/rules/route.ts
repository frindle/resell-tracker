import { NextRequest } from 'next/server';
import { withBooks } from '@/lib/books/api';
import { listRules, createRule, HttpError } from '@/lib/books/bank/service';
import { COST_CATEGORIES } from '@/lib/books/chart';

export async function GET() {
  return withBooks(async userId => Response.json({ rules: await listRules(userId), categories: COST_CATEGORIES }));
}

/** Body { pattern, isRegex?, sign?, bankAccountId?, minCents?, maxCents?, action, costCategory?, business? }. */
export async function POST(req: NextRequest) {
  return withBooks(async userId => {
    const body = await req.json().catch(() => ({}));
    try {
      return Response.json(await createRule(userId, body), { status: 201 });
    } catch (e) {
      if (e instanceof HttpError) return Response.json({ error: e.message }, { status: e.status });
      throw e;
    }
  });
}
