import { NextRequest } from 'next/server';
import { getSetting } from '@/lib/db';
import { getDeals, getDealItems } from '@/lib/bfmrWeb';
import { getSessionUserId } from '@/lib/auth';

let cached: { vendors: string[]; at: number } | null = null;
const TTL = 30 * 60 * 1000; // 30 min

export async function GET(req: NextRequest) {
  if (cached && Date.now() - cached.at < TTL) {
    return Response.json(cached.vendors);
  }

  const sessionUserId = await getSessionUserId();
  const extUserId = req.headers.get('X-Extension-User-Id');
  const uid: number | null = sessionUserId ?? (extUserId ? parseInt(extUserId) : null);

  const emailRow = await getSetting(uid, 'bfmr_email');
  const passwordRow = await getSetting(uid, 'bfmr_password');
  const email = emailRow?.value;
  const password = passwordRow?.value;
  if (!email || !password) return new Response('BFMR credentials not configured', { status: 503 });

  const deals = await getDeals(email, password, uid);
  const open = deals.filter(d => d.is_reservation_closed === 0);

  const vendorSet = new Set<string>();
  // Batch 5 at a time to avoid hammering BFMR
  for (let i = 0; i < open.length; i += 5) {
    const batch = open.slice(i, i + 5);
    await Promise.all(batch.map(async deal => {
      try {
        const { items } = await getDealItems(email, password, deal.slug, uid);
        for (const item of items) {
          for (const link of item.links ?? []) {
            if (link.vendor_name) vendorSet.add(link.vendor_name);
          }
        }
      } catch { /* skip failed deals */ }
    }));
  }

  const vendors = [...vendorSet].sort();
  cached = { vendors, at: Date.now() };
  return Response.json(vendors);
}
