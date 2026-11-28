import { NextRequest } from 'next/server';
import { getSessionUserId } from '@/lib/auth';
import { isOwner } from '@/lib/owner';
import { envDeps, listMachines, markPurchases, unmarkPurchases, requestItems, retryAll, fetchBlockedItems } from '@/lib/darkbloomPurchaseService';

export const dynamic = 'force-dynamic';

// GET: whether the ledger push is set up, and (for the hardware picker) the ledger's machines. Read-only.
export async function GET() {
  const uid = await getSessionUserId();
  if (uid == null) return Response.json({ error: 'not authenticated' }, { status: 401 });
  const d = envDeps();
  return Response.json({ configured: !!(d.url && d.token), machines: await listMachines(d) });
}

// POST { ids, action: 'mark' | 'unmark' | 'items' | 'push', category?, machineId? }
// mark: this order is a Darkbloom purchase (cost in bloom-ledger). unmark: it is not; a pushed entry is voided.
// items: ask the extension to read the merchant page again. push: retry every pending push now.
export async function POST(req: NextRequest) {
  const uid = await getSessionUserId();
  if (uid == null) return Response.json({ error: 'not authenticated' }, { status: 401 });
  if (!(await isOwner(uid))) return Response.json({ error: 'only the tracker owner can do this' }, { status: 403 });
  const b = await req.json().catch(() => ({})) as { ids?: unknown; action?: string; category?: unknown; machineId?: unknown };
  if (b.action === 'push') return Response.json(await retryAll());
  if (b.action === 'blocked-items') return Response.json(await fetchBlockedItems(uid, Array.isArray(b.ids) ? b.ids.filter((x): x is number => Number.isInteger(x)).slice(0, 200) : undefined));
  const ids = Array.isArray(b.ids) ? b.ids.filter((x): x is number => Number.isInteger(x)).slice(0, 200) : [];
  if (!ids.length) return Response.json({ error: 'ids required' }, { status: 400 });
  try {
    if (b.action === 'mark') return Response.json(await markPurchases(uid, ids, typeof b.category === 'string' ? b.category : undefined, typeof b.machineId === 'string' ? b.machineId : undefined));
    if (b.action === 'unmark') return Response.json(await unmarkPurchases(uid, ids));
    if (b.action === 'items') return Response.json({ asked: await requestItems(uid, ids) });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : 'failed' }, { status: 400 });
  }
  return Response.json({ error: 'action must be mark, unmark, items or push' }, { status: 400 });
}
