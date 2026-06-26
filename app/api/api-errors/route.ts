import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { logApiError } from '@/lib/apiErrorLog';
import { NextRequest } from 'next/server';

export const dynamic = 'force-dynamic';

// Ingest endpoint for the browser extension's API Spy. The extension
// forwards any non-2xx response it sees on cardcenter.cc / etc. so they
// land in the same /api-errors UI as server-side failures.
export async function POST(req: NextRequest) {
  try {
    const sessionUid = await getSessionUserId();
    const headerUid = req.headers.get('X-Extension-User-Id');
    const userId = sessionUid ?? (headerUid ? parseInt(headerUid) : null);

    const body = await req.json() as {
      group?: string;
      endpoint?: string;
      method?: string;
      status?: number;
      body?: string;
      context?: string;
    };
    if (!body.group || !body.endpoint) {
      return Response.json({ error: 'group + endpoint required' }, { status: 400 });
    }
    await logApiError({
      userId: userId ?? null,
      group: body.group,
      endpoint: body.endpoint,
      method: body.method,
      status: body.status,
      body: body.body,
      context: body.context ?? 'extension API spy',
    });
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  try {
    const userId = await getSessionUserId();
    if (userId == null) return Response.json({ error: 'not authenticated' }, { status: 401 });

    const url = new URL(req.url);
    const group = url.searchParams.get('group');
    const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '200'), 1000);

    const errors = await prisma.apiError.findMany({
      where: { userId, ...(group ? { group } : {}) },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return Response.json({ errors });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}

// Bulk-clear (handy when you've fixed something and want to start fresh)
export async function DELETE(req: NextRequest) {
  try {
    const userId = await getSessionUserId();
    if (userId == null) return Response.json({ error: 'not authenticated' }, { status: 401 });
    const url = new URL(req.url);
    const group = url.searchParams.get('group');
    const { count } = await prisma.apiError.deleteMany({
      where: { userId, ...(group ? { group } : {}) },
    });
    return Response.json({ cleared: count });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
