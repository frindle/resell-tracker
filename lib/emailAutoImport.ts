import { prisma, getSetting, upsertSetting } from '@/lib/db';
import { sendPushover } from '@/lib/pushover';
import { cloudflareCreds, INBOX_MODE_KEY } from '@/lib/emailCreds';
import { fetchCloudflareOrderEmails, deleteCloudflareMessages, type ParsedCache } from '@/lib/emailCloudflare';
import { mergeEmailImportRows } from '@/lib/emailParse';
import { planAutoImport, parseMissLine, heldSummary, needsAttention, digitsOf, type HeldEmail } from '@/lib/emailAutoImportPlan';

// Automatic order-email import. Every 5 minutes it reads the Cloudflare order
// inbox, imports what the Email tab would import by default (see
// emailAutoImportPlan.ts), and removes those emails from the inbox. Emails it
// leaves behind wait on the Email tab; each one gets one PII-free log line and
// one Pushover note to its user (or to everyone when no user claims it).
//
// Turned off with the global setting email_auto_import = "off".

const POLL_MS = 5 * 60 * 1000;
const BOOT_DELAY_MS = 2 * 60 * 1000;
export const AUTO_IMPORT_KEY = 'email_auto_import';
const ALERTED_KEY = 'email_auto_import_alerted';
const ALERTED_MAX = 500;

const cache: ParsedCache = new Map();
let running = false;

function baseUrl(): string {
  return `http://127.0.0.1:${process.env.PORT ?? 3000}`;
}

// The import route is the one place orders are created and updated (buyer
// match, cards, tracking submit, BFMR auto-link, books). Call it over loopback
// as the user, the way lib/autoSync.ts calls the sync routes.
async function importAs(uid: number, rows: unknown[]): Promise<Record<string, number>> {
  const secret = process.env.EXTENSION_SHARED_SECRET;
  const res = await fetch(`${baseUrl()}/api/import`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Extension-User-Id': String(uid),
      ...(secret ? { 'X-Extension-Secret': secret } : {}),
    },
    body: JSON.stringify(rows),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`/api/import → ${res.status} ${(await res.text().catch(() => '')).slice(0, 160)}`);
  return res.json();
}

async function alertedIds(): Promise<string[]> {
  try {
    const v = JSON.parse((await getSetting(null, ALERTED_KEY))?.value ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

async function notify(userIds: number[], message: string): Promise<void> {
  for (const uid of userIds) {
    const [key, token] = await Promise.all([getSetting(uid, 'pushover_user_key'), getSetting(uid, 'pushover_app_token')]);
    if (!key?.value || !token?.value) continue;
    await sendPushover(key.value, token.value, message, 'Order email').catch(e => console.error('[email-auto-import] pushover failed:', String(e).slice(0, 160)));
  }
}

async function alertHeld(held: HeldEmail[], allUserIds: number[]): Promise<void> {
  const worth = held.filter(h => needsAttention(h.reason));
  if (!worth.length) return;
  const seen = await alertedIds();
  const fresh = worth.filter(h => !seen.includes(h.id));
  if (!fresh.length) return;
  for (const h of fresh) console.log(parseMissLine(h));

  const byUser = new Map<number | null, HeldEmail[]>();
  for (const h of fresh) byUser.set(h.userId, [...(byUser.get(h.userId) ?? []), h]);
  for (const [uid, list] of byUser) await notify(uid == null ? allUserIds : [uid], heldSummary(list));

  // Inbox mail expires after 30 days, so the newest ids are all that matter.
  await upsertSetting(null, ALERTED_KEY, JSON.stringify([...seen, ...fresh.map(h => h.id)].slice(-ALERTED_MAX)));
}

export type AutoImportResult = { pulled: number; imported: Record<number, Record<string, number>>; held: number; removed: number };

export async function runEmailAutoImport(): Promise<AutoImportResult | null> {
  if (running) return null;
  running = true;
  try {
    const [mode, toggle] = await Promise.all([getSetting(null, INBOX_MODE_KEY), getSetting(null, AUTO_IMPORT_KEY)]);
    if (mode?.value !== 'cloudflare' || toggle?.value === 'off') return null;
    const cf = await cloudflareCreds();
    if (!cf) return null;

    const emails = await fetchCloudflareOrderEmails(cf, undefined, { cache });
    if (!emails.length) return { pulled: 0, imported: {}, held: 0, removed: 0 };

    const [users, senderRules, shippingRules] = await Promise.all([
      prisma.user.findMany({ select: { id: true } }),
      prisma.senderRule.findMany({ select: { userId: true, pattern: true } }),
      prisma.shippingRule.findMany({ select: { userId: true, pattern: true, buyerId: true } }),
    ]);
    const userIds = users.map(u => u.id);
    const orders = await prisma.order.findMany({ where: { userId: { in: userIds }, orderNumber: { not: null } }, select: { userId: true, orderNumber: true } });
    const known = new Map<number, Set<string>>();
    for (const o of orders) {
      if (o.userId == null) continue;
      const set = known.get(o.userId) ?? new Set<string>();
      const d = digitsOf(o.orderNumber);
      if (d) set.add(d);
      known.set(o.userId, set);
    }

    const plan = planAutoImport(emails, {
      rules: senderRules,
      onlyUserId: userIds.length === 1 ? userIds[0] : null,
      knownOrders: uid => known.get(uid) ?? new Set(),
      shippingRules: uid => shippingRules.filter(s => s.userId === uid && s.buyerId != null) as { pattern: string; buyerId: number }[],
      now: Date.now(),
    });

    const imported: AutoImportResult['imported'] = {};
    let removed = 0;
    for (const [uid, batch] of plan.users) {
      const merged = mergeEmailImportRows(batch.inputs);
      try {
        imported[uid] = merged.rows.length ? await importAs(uid, merged.rows) : {};
      } catch (e) {
        // Leave the emails in the inbox; the next run tries again.
        console.error(`[email-auto-import] import failed for user ${uid}:`, String(e).slice(0, 200));
        continue;
      }
      try {
        await deleteCloudflareMessages(cf, batch.ids);
        for (const id of batch.ids) cache.delete(id);
        removed += batch.ids.length;
      } catch (e) {
        // Imported but still in the inbox: the next run re-imports them, which
        // only verifies the same orders (the import matches by order number).
        console.error(`[email-auto-import] inbox delete failed for user ${uid}:`, String(e).slice(0, 200));
      }
      const c = imported[uid];
      console.log(`[email-auto-import] user=${uid} emails=${batch.ids.length} created=${c.imported ?? 0} updated=${c.updated ?? 0} verified=${c.verified ?? 0} skipped=${c.skipped ?? 0} noMatch=${c.skippedNoMatch ?? 0}${batch.noTotal ? ` noTotal=${batch.noTotal}` : ''}`);
      if (batch.noTotal) console.log(`[email-parse-miss] reason=ordered-without-total count=${batch.noTotal} user=${uid}`);
    }

    await alertHeld(plan.held, userIds);
    return { pulled: emails.length, imported, held: plan.held.length, removed };
  } catch (e) {
    console.error('[email-auto-import] run failed:', String(e).slice(0, 200));
    return null;
  } finally {
    running = false;
  }
}

export function startEmailAutoImport(): void {
  setTimeout(() => { void runEmailAutoImport(); }, BOOT_DELAY_MS);
  setInterval(() => { void runEmailAutoImport(); }, POLL_MS);
}
