// Server-side cross-group price index: one fetch per group per refresh (both
// groups need one items call per open deal, bounded and cached per slug), cached
// ~10 minutes per user. A group that is down or logged out is skipped and noted.
import { getSetting } from '@/lib/db';
import { collectGroups, computeFlags, parseThreshold, TtlCache, type CrossGroupFlag, type GroupEntry, type GroupLoad, type SkippedGroup } from '@/lib/crossGroup';
import { bfmrEntryFor, bgEntry } from '@/lib/crossGroupSources';
import { dealsFor, dealRawItemsFor, getBfmrRestCreds } from '@/lib/bfmrDeals';
import { getBgAccessToken, isBgConfigured } from '@/lib/bgAuth';
import { getDeals as getBgDeals, getCommitmentItems, type BGDeal, type BGCommitmentItem } from '@/lib/buyinggroup';

const TTL_MS = 10 * 60 * 1000;
const MAX_BFMR_DEALS = 200;
const BFMR_CONCURRENCY = 5;
const BG_PAGE_SIZE = 60;
const BG_MAX_PAGES = 20;
const MAX_BG_DEALS = 200;
const BG_CONCURRENCY = 5;
const MAX_ITEM_CACHES = 1000;

// Per-deal items, shared across refreshes and bounded in size.
const bgItemCaches = new Map<string, TtlCache<BGCommitmentItem[]>>();
function bgItemsFor(uid: number | null, token: string, key: string): Promise<BGCommitmentItem[]> {
  const k = `${uid ?? 'none'}:${key}`;
  let c = bgItemCaches.get(k);
  if (!c) {
    if (bgItemCaches.size >= MAX_ITEM_CACHES) bgItemCaches.delete(bgItemCaches.keys().next().value as string);
    c = new TtlCache<BGCommitmentItem[]>(TTL_MS);
    bgItemCaches.set(k, c);
  }
  return c.get(() => getCommitmentItems(token, key));
}

async function loadBfmr(uid: number | null): Promise<GroupLoad> {
  const creds = await getBfmrRestCreds(uid);
  if (!creds) throw new Error('BFMR API key not set (UPCs come from the REST API)');
  const open = (await dealsFor(uid)).filter(d => d.is_reservation_closed === 0).slice(0, MAX_BFMR_DEALS);
  const out: GroupEntry[] = [];
  let failed = 0;
  for (let i = 0; i < open.length; i += BFMR_CONCURRENCY) {
    await Promise.all(open.slice(i, i + BFMR_CONCURRENCY).map(async d => {
      try {
        const e = bfmrEntryFor(d, await dealRawItemsFor(creds, d.slug));
        if (e) out.push(e);
      } catch { failed++; } // one bad deal is not a down group, but it is counted
    }));
  }
  return { entries: out, failed };
}

async function loadBg(uid: number | null): Promise<GroupLoad> {
  if (!await isBgConfigured(uid)) throw new Error('BuyingGroup not configured');
  const token = await getBgAccessToken(uid);
  const byKey = new Map<string, BGDeal>();
  for (let page = 1; page <= BG_MAX_PAGES; page++) {
    const { results } = await getBgDeals(token, { page, pageSize: BG_PAGE_SIZE, dataType: 'active' });
    const before = byKey.size;
    for (const d of results) byKey.set(d.key, d);
    if (results.length === 0 || byKey.size === before) break; // BG may ignore page_size: stop on empty or repeat
  }
  // The deal list has no UPC or model; those come from the per-deal items call.
  const deals = [...byKey.values()].slice(0, MAX_BG_DEALS);
  const out: GroupEntry[] = [];
  let failed = 0;
  for (let i = 0; i < deals.length; i += BG_CONCURRENCY) {
    await Promise.all(deals.slice(i, i + BG_CONCURRENCY).map(async d => {
      try {
        const items = await bgItemsFor(uid, token, d.key);
        const e = bgEntry(d as unknown as Record<string, unknown>, items as unknown as Record<string, unknown>[]);
        if (e) out.push(e);
      } catch { failed++; }
    }));
  }
  return { entries: out, failed };
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
