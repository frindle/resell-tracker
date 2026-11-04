import { NextRequest } from 'next/server';
import { getSessionUserId } from '@/lib/auth';
import { resolveExtensionUserId } from '@/lib/extensionAuth';
import { dealsFor, dealItemsFor, BfmrNotConfiguredError } from '@/lib/bfmrDeals';

let cached: { vendors: string[]; at: number } | null = null;
const TTL = 30 * 60 * 1000; // 30 min

export async function GET(req: NextRequest) {
  if (cached && Date.now() - cached.at < TTL) {
    return Response.json(cached.vendors);
  }

  const sessionUserId = await getSessionUserId();
  const uid = resolveExtensionUserId(req, sessionUserId);

  let deals;
  try {
    deals = await dealsFor(uid);
  } catch (e) {
    if (e instanceof BfmrNotConfiguredError) return new Response(e.message, { status: 503 });
    return new Response(String(e), { status: 502 });
  }
  const open = deals.filter(d => d.is_reservation_closed === 0);

  const vendorSet = new Set<string>();
  // Batch 5 at a time to avoid hammering BFMR
  for (let i = 0; i < open.length; i += 5) {
    const batch = open.slice(i, i + 5);
    await Promise.all(batch.map(async deal => {
      try {
        const { items } = await dealItemsFor(uid, deal.slug);
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
