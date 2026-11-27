// Cross-group payout comparison. Pure (no imports), unit tested.
//
// Each buying group lists deals with a per-unit payout. When the same product
// (exact UPC, else exact model or part number) is bought by another group for
// more, the deal gets a flag. Title similarity is never a match.

export type GroupId = 'bfmr' | 'bg' | 'bigsky';

export const GROUP_LABEL: Record<GroupId, string> = { bfmr: 'BFMR', bg: 'BG', bigsky: 'BigSky' };

export const DEFAULT_THRESHOLD = 1;

export type GroupEntry = {
  group: GroupId;
  id: string;          // BFMR slug, BG deal key
  title: string;
  payout: number;      // per-unit dollars
  upcs: string[];      // raw, normalized on index
  models: string[];    // raw, normalized on index
  href: string;        // in-app page that shows this deal
};

export type CrossGroupFlag = {
  group: GroupId;
  id: string;
  title: string;
  payout: number;
  diff: number;        // other group's payout minus this deal's payout
  href: string;
  matchedBy: 'upc' | 'model';
};

export type SkippedGroup = { group: GroupId; reason: string };

/**
 * UPC-A (12), EAN-13 and GTIN-14 spell the same code with leading zeros, so
 * compare on the digits with leading zeros dropped. Fewer than 8 significant
 * digits is not a usable code; all zeros is a placeholder.
 */
export function normalizeUpc(raw: unknown): string | null {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length < 8 || digits.length > 14) return null;
  const sig = digits.replace(/^0+/, '');
  return sig.length >= 8 ? sig : null;
}

const MODEL_PLACEHOLDERS = new Set(['NA', 'N/A', 'NONE', 'NULL', 'UNKNOWN', 'TBD']);

/**
 * An exact model or part number: case and whitespace do not matter, nothing
 * else is loosened ("MJED4LS/A" is not "MJED4LS"). It must have both a letter
 * and a digit and at least 5 characters, so "Black" or "2024" never match.
 */
export function normalizeModel(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const m = raw.toUpperCase().replace(/\s+/g, '');
  if (m.length < 5 || MODEL_PLACEHOLDERS.has(m)) return null;
  if (!/[A-Z]/.test(m) || !/\d/.test(m)) return null;
  return m;
}

export type CrossGroupIndex = {
  entries: GroupEntry[];
  byUpc: Map<string, GroupEntry[]>;
  byModel: Map<string, GroupEntry[]>;
};

function push<K, V>(m: Map<K, V[]>, k: K, v: V) {
  const a = m.get(k);
  if (a) { if (!a.includes(v)) a.push(v); } else m.set(k, [v]);
}

const usable = (e: GroupEntry) => Number.isFinite(e.payout) && e.payout > 0;

export function buildIndex(entries: GroupEntry[]): CrossGroupIndex {
  const byUpc = new Map<string, GroupEntry[]>();
  const byModel = new Map<string, GroupEntry[]>();
  for (const e of entries) {
    if (!usable(e)) continue;
    for (const u of e.upcs) { const n = normalizeUpc(u); if (n) push(byUpc, n, e); }
    for (const m of e.models) { const n = normalizeModel(m); if (n) push(byModel, n, e); }
  }
  return { entries, byUpc, byModel };
}

/**
 * The best-paying match in another group, when it beats this deal by more than
 * `threshold`. A UPC match wins over a model match; model is tried only when
 * no other group matched on UPC.
 */
export function flagFor(entry: GroupEntry, index: CrossGroupIndex, threshold = DEFAULT_THRESHOLD): CrossGroupFlag | null {
  const others = (list: GroupEntry[] | undefined) => (list ?? []).filter(o => o.group !== entry.group);
  const hits = new Set<GroupEntry>();
  for (const u of entry.upcs) { const n = normalizeUpc(u); if (n) for (const o of others(index.byUpc.get(n))) hits.add(o); }
  let matchedBy: 'upc' | 'model' = 'upc';
  if (hits.size === 0) {
    matchedBy = 'model';
    for (const m of entry.models) { const n = normalizeModel(m); if (n) for (const o of others(index.byModel.get(n))) hits.add(o); }
  }
  let best: GroupEntry | null = null;
  for (const o of hits) if (!best || o.payout > best.payout) best = o;
  if (!best) return null;
  const diff = best.payout - entry.payout;
  if (!(diff > threshold)) return null;
  return { group: best.group, id: best.id, title: best.title, payout: best.payout, diff: Math.round(diff * 100) / 100, href: best.href, matchedBy };
}

export const flagKey = (group: GroupId, id: string) => `${group}:${id}`;

export function computeFlags(entries: GroupEntry[], threshold = DEFAULT_THRESHOLD): Record<string, CrossGroupFlag> {
  const index = buildIndex(entries);
  const out: Record<string, CrossGroupFlag> = {};
  for (const e of entries) {
    if (!usable(e)) continue;
    const f = flagFor(e, index, threshold);
    if (f) out[flagKey(e.group, e.id)] = f;
  }
  return out;
}

export function badgeText(f: Pick<CrossGroupFlag, 'group' | 'diff'>): string {
  return `${GROUP_LABEL[f.group]} pays $${f.diff.toFixed(2)} more`;
}

/** Threshold setting text to dollars; blank, junk or negative falls back to the default. */
export function parseThreshold(v: string | null | undefined): number {
  const n = Number(v);
  return v != null && v.trim() !== '' && Number.isFinite(n) && n >= 0 ? n : DEFAULT_THRESHOLD;
}

export type GroupLoader = { group: GroupId; load: () => Promise<GroupEntry[]> };

/** One load per group; a group that throws is skipped and noted, never fatal. */
export async function collectGroups(loaders: GroupLoader[]): Promise<{ entries: GroupEntry[]; skipped: SkippedGroup[] }> {
  const results = await Promise.all(loaders.map(async l => {
    try { return { ok: true as const, entries: await l.load() }; }
    catch (e) { return { ok: false as const, group: l.group, reason: e instanceof Error ? e.message : String(e) }; }
  }));
  const entries: GroupEntry[] = [];
  const skipped: SkippedGroup[] = [];
  for (const r of results) {
    if (r.ok) entries.push(...r.entries);
    else skipped.push({ group: r.group, reason: r.reason.slice(0, 200) });
  }
  return { entries, skipped };
}

/** Small TTL cache that shares one in-flight load between callers. */
export class TtlCache<T> {
  private hit: { at: number; value: T } | null = null;
  private inflight: Promise<T> | null = null;
  private ttlMs: number;
  private now: () => number;
  constructor(ttlMs: number, now: () => number = Date.now) { this.ttlMs = ttlMs; this.now = now; }
  async get(load: () => Promise<T>): Promise<T> {
    if (this.hit && this.now() - this.hit.at < this.ttlMs) return this.hit.value;
    if (this.inflight) return this.inflight;
    this.inflight = load()
      .then(value => { this.hit = { at: this.now(), value }; return value; })
      .finally(() => { this.inflight = null; });
    return this.inflight;
  }
}
