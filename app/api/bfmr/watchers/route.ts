import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { getDealItems } from '@/lib/bfmrWeb';
import { getSetting } from '@/lib/db';

export async function GET() {
  const userId = await getSessionUserId();
  const watchers = await prisma.bfmrWatcher.findMany({
    where: { userId: userId ?? null },
    orderBy: { createdAt: 'desc' },
  });
  return Response.json(watchers);
}

export async function POST(req: NextRequest) {
  const userId = await getSessionUserId();
  const uid = userId ?? null;
  const { dealSlug, itemId, qty } = await req.json() as { dealSlug: string; itemId: number; qty: number };

  if (!dealSlug || !itemId || !qty) return new Response('Missing fields', { status: 400 });

  const emailRow = await getSetting(uid, 'bfmr_email');
  const passwordRow = await getSetting(uid, 'bfmr_password');
  if (!emailRow?.value || !passwordRow?.value) return new Response('BFMR credentials not configured', { status: 400 });

  // Fetch deal info for display names
  let dealTitle: string | undefined;
  let itemName: string | undefined;
  try {
    const info = await getDealItems(emailRow.value, passwordRow.value, dealSlug, uid);
    dealTitle = info.dealTitle;
    itemName = info.items.find(i => i.item_id === itemId)?.item_name;
  } catch {
    // non-fatal — watcher still gets created
  }

  const watcher = await prisma.bfmrWatcher.create({
    data: { userId: uid, dealSlug, dealTitle, itemId, itemName, qty, active: true },
  });

  return Response.json(watcher, { status: 201 });
}
