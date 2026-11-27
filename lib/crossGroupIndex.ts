// Server-side cross-group price index: one fetch per group per refresh (BFMR
// needs one items call per open deal, inside that refresh), cached ~10 minutes
// per user. A group that is down or logged out is skipped and noted.
import { getSetting } from '@/lib/db';
import { collectGroups, computeFlags, parseThreshold, TtlCache, type CrossGroupFlag, type GroupEntry, type SkippedGroup } from '@/lib/crossGroup';
import { bfmrEntry, bgEntry } from '@/lib/crossGroupSources';
import { dealsFor, dealRawItemsFor, getBfmrRestCreds } from '@/lib/bfmrDeals';
import { getBgAccessToken, isBgConfigured } from '@/lib/bgAuth';
import { getDeals as getBgDeals, type BGDeal } from '@/lib/buyinggroup';

const TTL_MS = 10 * 60 * 1000;
const MAX_BFMR_DEALS = 200;
const BFMR_CONCURRENCY = 5;
const BG_PAGE_SIZE = 60;
const BG_MAX_PAGES = 20;

async function loadBfmr(uid: number | null): Promise<GroupEntry[]> {
  const creds = await getBfmrRestCreds(uid);
  if (!creds) throw new Error('BFMR API key not set (UPCs come from the REST API)');
  const open = (await dealsFor(uid)).filter(d => d.is_reservation_closed === 0).slice(0, MAX_BFMR_DEALS);
  const out: GroupEntry[] = [];
  for (let i = 0; i < open.length; i += BFMR_CONCURRENCY) {
    await Promise.all(open.slice(i, i + BFMR_CONCURRENCY).map(async d => {
      try { out.push(bfmrEntry(d, await dealRawItemsFor(creds, d.slug))); } catch { /* one bad deal is not a down group */ }
    }));
  }
  return out;
}

async function loadBg(uid: number | null): Promise<GroupEntry[]> {
  if (!await isBgConfigured(uid)) throw new Error('BuyingGroup not configured');
  const token = await getBgAccessToken(uid);
  const byKey = new Map<string, BGDeal>();
  for (let page = 1; page <= BG_MAX_PAGES; page++) {
    const { results } = await getBgDeals(token, { page, pageSize: BG_PAGE_SIZE, dataType: 'active' });
    const before = byKey.size;
    for (const d of results) byKey.set(d.key, d);
    if (results.length === 0 || byKey.size === before) break; // BG may ignore page_size: stop on empty or repeat
  }
  const out: GroupEntry[] = [];
  for (const d of byKey.values()) { const e = bgEntry(d as unknown as Record<string, unknown>); if (e) out.push(e); }
  return out;
}

type Snapshot = { entries: GroupEntry[]; skipped: SkippedGroup[]; at: number };
const caches = new Map<string, TtlCache<Snapshot>>();

async function snapshot(uid: number | null): Promise<Snapshot> {
  const k = String(uid ?? 'none');
  let c = caches.get(k);
  if (!c) { c = new TtlCache<Snapshot>(TTL_MS); caches.set(k, c); }
  return c.get(async () => {
    const r = await collectGroups([
      { group: 'bfmr', load: () => loadBfmr(uid) },
      { group: 'bg', load: () => loadBg(uid) },
    ]);
    return { ...r, at: Date.now() };
  });
}

export type CrossGroupResult = {
  flags: Record<string, CrossGroupFlag>;
  skipped: SkippedGroup[];
  threshold: number;
  asOf: number;
};

export async function crossGroupFor(uid: number | null): Promise<CrossGroupResult> {
  const [snap, t] = await Promise.all([snapshot(uid), getSetting(uid, 'cross_group_threshold')]);
  const threshold = parseThreshold(t?.value);
  return { flags: computeFlags(snap.entries, threshold), skipped: snap.skipped, threshold, asOf: snap.at };
}
