import { prisma } from './db';
import { exclusive } from './books/exclusive';
import { getOwnerUserId, isOwner } from './owner';
import { runTallySync } from './books/service';
import { runBloomPayments } from './bloomPaymentService';
import { syncInvoices, fetchMonthToDate, type InvoiceRows, type InvoiceMoney, type InvoiceSyncResult } from './bloomInvoice';

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

// Months to date, read live from the ledger for the P&L. Cached briefly so each analytics load does not re-tally the ledger;
// a failed read is cached for a minute and leaves that month out (the page shows what is stored).
const toDateCache = new Map<string, { at: number; value: InvoiceMoney | null }>();
const TO_DATE_TTL_MS = 5 * 60_000;
const TO_DATE_FAIL_TTL_MS = 60_000;

/** This month and last month in Los Angeles time, 'YYYY-MM' (last month first). */
export function recentMonths(now = new Date()): [string, string] {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit' }).formatToParts(now);
  const y = Number(parts.find(p => p.type === 'year')!.value), m = Number(parts.find(p => p.type === 'month')!.value);
  const prev = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
  return [prev, `${y}-${String(m).padStart(2, '0')}`];
}

async function monthToDate(baseUrl: string, month: string): Promise<InvoiceMoney | null> {
  const hit = toDateCache.get(month);
  if (hit && Date.now() - hit.at < (hit.value ? TO_DATE_TTL_MS : TO_DATE_FAIL_TTL_MS)) return hit.value;
  let value: InvoiceMoney | null = null;
  try {
    value = await fetchMonthToDate({ baseUrl, month });
  } catch (e) { console.error(`[bloom] ${month} to date:`, e instanceof Error ? e.message : e); }
  toDateCache.set(month, { at: Date.now(), value });
  return value;
}

/** The stored invoices plus, for this month and last month when no invoice is stored for them yet, the ledger's figures to
 *  date (the owner only; nothing extra when BLOOM_LEDGER_URL is unset or the ledger does not answer). */
export async function loadInvoiceMoneyToDate(userId: number | null): Promise<InvoiceMoney[]> {
  const stored = await loadInvoiceMoney(userId);
  const base = process.env.BLOOM_LEDGER_URL;
  if (userId == null || !base || !(await isOwner(userId))) return stored;
  const have = new Set(stored.map(i => i.month));
  const live = await Promise.all(recentMonths().filter(m => !have.has(m)).map(m => monthToDate(base, m)));
  const extra = live.filter((i): i is InvoiceMoney => i != null && (i.grossCents !== 0 || i.netCents !== 0));
  return extra.length ? [...stored, ...extra].sort((a, b) => a.month.localeCompare(b.month)) : stored;
}
