import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { parseClickUrl } from '@/lib/portalPicker';

// Set (or clear, with an empty string) a portal's store page for a merchant.
// The page is the same for every category, so every row of that merchant and portal gets it.
export async function PUT(req: NextRequest) {
  try {
    const { merchant, portal, clickUrl } = await req.json() as { merchant?: string; portal?: string; clickUrl?: string };
    if (!merchant?.trim() || !portal?.trim()) return new Response('merchant and portal are required', { status: 400 });
    const url = parseClickUrl(clickUrl);
    if (url === null) return new Response('clickUrl must be an http(s) link', { status: 400 });
    const r = await prisma.portalRate.updateMany({
      where: { merchant: merchant.trim(), portal: portal.trim() },
      data: { clickUrl: url || null },
    });
    if (r.count === 0) return new Response('No such portal rate', { status: 404 });
    return Response.json({ updated: r.count, clickUrl: url || null });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
