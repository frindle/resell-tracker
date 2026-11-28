import { recordRemittanceForOwner } from '@/lib/groupRemittance';
import { fallbackRef } from '@/lib/groupRemittancePlan';
import { listCloudflareMessages, fetchCloudflareRaw, type CloudflareCreds } from '@/lib/emailCloudflare';
import { parseRawOrderEmail } from '@/lib/emailMessage';
import type { RemittanceEmail } from '@/lib/emailAutoImportPlan';

// Runs group payment emails through the recorder. Counts only in the logs: no tracking numbers or amounts.

export type RemittanceRunResult = { emails: number; exact: number; totalOnly: number; unowned: number; unresolvedLines: number };

/** Message ids already recorded exactly: not read again. A total-only one is retried on every poll, since tracking may arrive later. */
const done = new Set<string>();

export async function recordRemittanceEmails(list: readonly RemittanceEmail[]): Promise<RemittanceRunResult> {
  const r: RemittanceRunResult = { emails: 0, exact: 0, totalOnly: 0, unowned: 0, unresolvedLines: 0 };
  for (const { id, remittance: p } of list) {
    if (done.has(id) || !p.paidDay) continue;
    r.emails++;
    const res = await recordRemittanceForOwner({
      group: p.group, ref: p.ref ?? fallbackRef(p.paidDay, p.totalCents, p.lines), totalCents: p.totalCents, paidDay: p.paidDay, lines: p.lines,
    });
    if (!res) { r.unowned++; continue; }
    r.unresolvedLines += res.unresolved;
    if (res.exact) { r.exact++; done.add(id); } else r.totalOnly++;
  }
  if (r.emails) console.log(`[group-remittance] emails=${r.emails} exact=${r.exact} totalOnly=${r.totalOnly} unowned=${r.unowned} unresolvedLines=${r.unresolvedLines}`);
  return r;
}

/**
 * Re-reads every group payment email still in the worker's inbox and its 7-day archive (payment emails are never deleted from the
 * inbox, so this reaches all of them) and records them. Idempotent: the same payment id updates in place.
 */
export async function backfillRemittances(cf: CloudflareCreds, fetchFn: typeof fetch = fetch): Promise<RemittanceRunResult & { listed: number }> {
  const found: RemittanceEmail[] = [];
  let listed = 0;
  for (const area of ['/messages', '/archive'] as const) {
    let msgs;
    try { msgs = await listCloudflareMessages(cf, fetchFn, area); } catch { continue; }
    listed += msgs.length;
    for (const m of msgs) {
      try {
        const raw = await fetchCloudflareRaw(cf, m.id, fetchFn, area);
        if (!raw) continue;
        const row = await parseRawOrderEmail(raw, m.id, { shared: true, envelopeTo: m.to, bgReceipts: true });
        if (row?.remittance) found.push({ id: `${area}:${m.id}`, remittance: row.remittance });
      } catch { /* a malformed or unreachable message is skipped */ }
    }
  }
  return { ...(await recordRemittanceEmails(found)), listed };
}
