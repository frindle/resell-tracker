import { NextRequest } from 'next/server';
import { getSessionUserId } from '@/lib/auth';
import { logApiError } from '@/lib/apiErrorLog';
import { cleanClientError, shouldLogClientError } from '@/lib/clientErrorReport';

export const dynamic = 'force-dynamic';

const seen = new Map<string, number>();

// POST from app/error.tsx and app/global-error.tsx when a page fails in the browser (lib/clientErrorReport.ts).
export async function POST(req: NextRequest) {
  const userId = await getSessionUserId();
  if (userId == null) return new Response(null, { status: 401 });
  const r = cleanClientError(await req.json().catch(() => null));
  if (!r) return new Response(null, { status: 400 });
  if (shouldLogClientError(seen, r, Date.now())) {
    console.error(`[client-error] user ${userId} ${r.path}: ${r.message}${r.digest ? ` (digest ${r.digest})` : ''}\n${r.stack}`);
    await logApiError({ userId, group: 'Client', endpoint: r.path, context: r.message, body: r.stack || undefined });
  }
  return new Response(null, { status: 204 });
}
