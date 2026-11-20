import { prisma } from './db';
import { exclusive } from './books/exclusive';
import { getOwnerUserId, isOwner } from './owner';
import { runTallySync } from './books/service';
import { runBloomPayments } from './bloomPaymentService';
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

/**
 * Pull the invoices, record the month's payment (requests and deposits, see bloomPayment.ts), then the books' Darkbloom tally in the same step, so the month Penn sees under Bloom invoices and the
 * month posted in Books are created together from the same ledger answer (the tally post is skipped when accounting is off).
 */
export async function runBloomAndBooks(userId: number): Promise<InvoiceSyncResult | { notOwner: true }> {
  const r = await runBloomSync(userId);
  if ('notOwner' in r || 'disabled' in r) return r;
  try {   // the payment record: copy 1 of each new month, the payout requests, the matching deposits, copy 2
    const p = await runBloomPayments(userId);
    if ('errors' in p) r.errors.push(...p.errors);
  } catch (e) { r.errors.push(`payments: ${e instanceof Error ? e.message : String(e)}`); }
  try {
    const on = await prisma.setting.findFirst({ where: { key: 'accounting.enabled', value: 'true', userId }, select: { userId: true } });
    if (on) await runTallySync(userId);
  } catch (e) { r.errors.push(`books: ${e instanceof Error ? e.message : String(e)}`); }
  return r;
}

/** Daily run: the owner's account only. */
export async function bloomSyncAllUsers(): Promise<void> {
  if (!process.env.BLOOM_LEDGER_URL) return;
  const id = await getOwnerUserId();
  if (id == null) return;
  try {
    const r = await runBloomAndBooks(id);
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
