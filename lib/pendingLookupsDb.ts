import { prisma, getSetting } from '@/lib/db';
import { pendingLookupsFor, type PendingLookup, type LookupOrder } from '@/lib/pendingLookups';

const digits = (s: string | null | undefined) => String(s ?? '').replace(/\D/g, '');

/** Pending page scrapes for a user's orders, keyed by order id. Computed from the Amazon visit queue and waiting Costco/Walmart lookup commands. */
export async function loadPendingLookups(uid: number | null, orders: readonly (LookupOrder & { id: number })[]): Promise<Map<number, PendingLookup>> {
  const out = new Map<number, PendingLookup>();
  if (uid == null || !orders.some(o => o.orderNumber)) return out;
  const [setting, cmds] = await Promise.all([
    getSetting(uid, 'amazon_visit_state'),
    prisma.extensionCommand.findMany({ where: { type: { in: ['SYNC_COSTCO_ORDER', 'SYNC_WALMART_ORDER'] }, status: { in: ['pending', 'running'] } }, select: { payload: true } }),
  ]);
  const stores: string[] = [];
  for (const c of cmds) {
    try {
      const p = JSON.parse(c.payload ?? '{}') as { orderNumbers?: unknown; userId?: unknown };
      if (p.userId === uid && Array.isArray(p.orderNumbers)) stores.push(...p.orderNumbers.map(String));
    } catch { /* ignore bad payload */ }
  }
  const byNum = pendingLookupsFor(setting?.value, orders, new Date(), stores);
  for (const o of orders) { const p = byNum.get(digits(o.orderNumber)); if (p) out.set(o.id, p); }
  return out;
}
