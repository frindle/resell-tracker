import { prisma } from './db';
import { exclusive } from './books/exclusive';
import { getOwnerUserId, isOwner } from './owner';
import { syncInvoices, type InvoiceRows, type InvoiceMoney, type InvoiceSyncResult } from './bloomInvoice';

const rows: InvoiceRows = {
  async getHash(userId, month) {
    const r = await prisma.bloomInvoice.findUnique({ where: { userId_month: { userId, month } }, select: { hash: true } });
    return r?.hash ?? null;
  },
  async upsert(userId, row) {
    const data = {
      hash: row.hash, grossCents: row.grossCents, otherIncomeCents: row.otherIncomeCents, feesCents: row.feesCents,
      costsCents: row.costsCents, netCents: row.netCents, payload: row.payload,
    };
    await prisma.bloomInvoice.upsert({
      where: { userId_month: { userId, month: row.month } },
      create: { userId, month: row.month, ...data },
      update: { ...data, fetchedAt: new Date() },
    });
  },
};

/**
 * Pull the ledger's final months. The ledger holds one person's Bloom earnings, so only the tracker owner's account
 * (lib/owner.ts) pulls it; any other user gets notOwner. Serialised per user, so the daily run and the button cannot race.
 */
export async function runBloomSync(userId: number): Promise<InvoiceSyncResult | { notOwner: true }> {
  if (!(await isOwner(userId))) return { notOwner: true };
  return exclusive(userId, () => syncInvoices(rows, userId, { baseUrl: process.env.BLOOM_LEDGER_URL }));
}

/** Daily run: the owner's account only. */
export async function bloomSyncAllUsers(): Promise<void> {
  if (!process.env.BLOOM_LEDGER_URL) return;
  const id = await getOwnerUserId();
  if (id == null) return;
  try {
    const r = await runBloomSync(id);
    if ('errors' in r && r.errors.length) console.error('[bloom] invoice sync:', r.errors.join('; '));
  } catch (e) { console.error('[bloom] invoice sync failed:', e); }
}

/** The signed-in user's invoices as the P&L needs them (none unless they are the owner). */
export async function loadInvoiceMoney(userId: number | null): Promise<InvoiceMoney[]> {
  if (userId == null || !(await isOwner(userId))) return [];
  return prisma.bloomInvoice.findMany({
    where: { userId }, orderBy: { month: 'asc' },
    select: { month: true, grossCents: true, otherIncomeCents: true, feesCents: true, costsCents: true, netCents: true },
  });
}
