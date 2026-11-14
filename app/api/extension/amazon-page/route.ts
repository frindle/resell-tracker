import { NextRequest } from 'next/server';
import { getSessionUserId } from '@/lib/auth';
import { resolveExtensionUserId } from '@/lib/extensionAuth';
import { handleCapturedPage, validateAmazonUrl, isPageKind, MAX_HTML_BYTES } from '@/lib/amazonCaptureServer';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const userId = resolveExtensionUserId(req, await getSessionUserId());
    if (userId == null) return Response.json({ error: 'unauthorized' }, { status: 401 });
    const body = await req.json().catch(() => null) as { url?: unknown; kind?: unknown; html?: unknown } | null;
    const url = validateAmazonUrl(body?.url);
    if (!url) return Response.json({ error: 'url must be https://www.amazon.com/...' }, { status: 400 });
    if (!isPageKind(body?.kind)) return Response.json({ error: 'kind must be orders|detail|tracking' }, { status: 400 });
    if (typeof body?.html !== 'string' || !body.html) return Response.json({ error: 'html required' }, { status: 400 });
    if (body.html.length > MAX_HTML_BYTES) return Response.json({ error: 'page too large' }, { status: 413 });
    const result = await handleCapturedPage(req, userId, url, body.kind, body.html);
    return Response.json({ ok: true, result });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
