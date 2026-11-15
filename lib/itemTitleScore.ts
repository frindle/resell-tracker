// Token-overlap match between an order's item description and a deal
// title. Distinctive tokens (model numbers, long words) count extra so
// "PS5" or "MacBook" agreeing matters more than "console" or "series".
const STOP_WORDS = new Set(['the', 'a', 'an', 'of', 'and', 'for', 'with', 'pack', 'count', 'new', 'series', 'edition', 'bundle']);

function tokenize(s: string): Set<string> {
  return new Set(
    s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ')
      .filter(t => t.length >= 3 && !STOP_WORDS.has(t))
  );
}

export function itemTitleScore(desc: string, title: string): number {
  const a = tokenize(desc);
  const b = tokenize(title);
  if (a.size === 0 || b.size === 0) return 0;
  let hits = 0;
  let strong = 0;
  for (const t of a) {
    if (b.has(t)) {
      hits++;
      if (/\d/.test(t) || t.length >= 6) strong++;
    }
  }
  return hits / Math.min(a.size, b.size) + strong * 0.15;
}
