import { prisma, getSetting } from './db';
import { sendPushover } from './pushover';

// Background auto-sync: runs the CardCenter payment sync and BFMR
// reservation/order syncs on a schedule, so orders mark themselves
// paid/processed without anyone clicking Sync. When a sync flips an
// order from unpaid → paid, the user gets a "Payment received" Pushover.
//
// The syncs stay HTTP routes (they're big and battle-tested); this calls
// them over loopback with the X-Extension-User-Id header the routes
// already accept for non-session callers.

const SYNC_MS = 6 * 60 * 60 * 1000; // every 6h
const BOOT_DELAY_MS = 10 * 60 * 1000; // stagger away from bgSync's boot run

function baseUrl(): string {
  return `http://127.0.0.1:${process.env.PORT ?? 3000}`;
}

async function usersWithSyncSources(): Promise<Array<{ uid: number; cc: boolean; bfmr: boolean; bigsky: boolean }>> {
  const rows = await prisma.setting.findMany({
    where: { key: { in: ['cc_email', 'bfmr_api_key', 'bigsky_cookie'] }, value: { not: '' } },
    select: { userId: true, key: true },
  });
  const byUid = new Map<number, { uid: number; cc: boolean; bfmr: boolean; bigsky: boolean }>();
  for (const r of rows) {
    if (r.userId == null) continue;
    const e = byUid.get(r.userId) ?? { uid: r.userId, cc: false, bfmr: false, bigsky: false };
    if (r.key === 'cc_email') e.cc = true;
    if (r.key === 'bfmr_api_key') e.bfmr = true;
    if (r.key === 'bigsky_cookie') e.bigsky = true;
    byUid.set(r.userId, e);
  }
  return [...byUid.values()];
}

async function loopbackPost(path: string, uid: number, body?: unknown): Promise<void> {
  const secret = process.env.EXTENSION_SHARED_SECRET;
  const res = await fetch(`${baseUrl()}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Extension-User-Id': String(uid),
      // Routes now correlate the header claim to this secret when it's
      // configured (see lib/extensionAuth.ts) — without it, this
      // in-process scheduler would get silently rejected (uid null) on
      // every sync once EXTENSION_SHARED_SECRET is set.
      ...(secret ? { 'X-Extension-Secret': secret } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${path} → ${res.status} ${text.slice(0, 160)}`);
  }
}

export async function runAutoSync(): Promise<void> {
  let users;
  try { users = await usersWithSyncSources(); }
  catch (e) { console.error('[auto-sync] user lookup failed:', e); return; }

  for (const u of users) {
    try {
      // Snapshot unpaid orders so we can tell exactly which ones this
      // sync pass flipped to paid.
      const unpaidBefore = await prisma.order.findMany({
        where: { userId: u.uid, salePriceSynced: false, lost: false },
        select: { id: true },
      });
      const unpaidIds = unpaidBefore.map(o => o.id);

      if (u.cc) {
        await loopbackPost('/api/cardcenter/sync-payments', u.uid).catch(e =>
          console.warn(`[auto-sync] uid=${u.uid} CC sync failed:`, String(e).slice(0, 200)));
      }
      if (u.bfmr) {
        await loopbackPost('/api/bfmr/sync-reservations', u.uid).catch(e =>
          console.warn(`[auto-sync] uid=${u.uid} BFMR reservations failed:`, String(e).slice(0, 200)));
        await loopbackPost('/api/bfmr/sync-orders', u.uid, { items: [], fetch: true, force: false }).catch(e =>
          console.warn(`[auto-sync] uid=${u.uid} BFMR orders failed:`, String(e).slice(0, 200)));
      }
      if (u.bigsky) {
        await loopbackPost('/api/bigsky/sync-orders', u.uid, { fetch: true }).catch(e =>
          console.warn(`[auto-sync] uid=${u.uid} BigSky sync failed:`, String(e).slice(0, 200)));
      }

      if (unpaidIds.length === 0) continue;
      const nowPaid = await prisma.order.findMany({
        where: { id: { in: unpaidIds }, salePriceSynced: true },
        select: { itemDescription: true, orderNumber: true, salePrice: true, buyer: { select: { name: true } } },
      });
      if (nowPaid.length === 0) continue;

      const userKey = await getSetting(u.uid, 'pushover_user_key');
      const appToken = await getSetting(u.uid, 'pushover_app_token');
      if (!userKey?.value || !appToken?.value) continue;

      const total = nowPaid.reduce((s, o) => s + (o.salePrice ?? 0), 0);
      const lines = nowPaid.slice(0, 8).map(o =>
        `$${(o.salePrice ?? 0).toFixed(2)} — ${(o.itemDescription ?? o.orderNumber ?? '?').slice(0, 60)}${o.buyer ? ` (${o.buyer.name})` : ''}`);
      if (nowPaid.length > 8) lines.push(`…and ${nowPaid.length - 8} more`);
      await sendPushover(
        userKey.value,
        appToken.value,
        lines.join('\n'),
        `Payment received — ${nowPaid.length} order${nowPaid.length === 1 ? '' : 's'}, $${total.toFixed(2)}`,
      );
      console.log(`[auto-sync] uid=${u.uid}: notified ${nowPaid.length} newly-paid order(s), $${total.toFixed(2)}`);
    } catch (e) {
      console.error(`[auto-sync] uid=${u.uid} pass failed:`, e);
    }
  }
}

export function startAutoSync(): void {
  setTimeout(runAutoSync, BOOT_DELAY_MS);
  setInterval(runAutoSync, SYNC_MS);
}
