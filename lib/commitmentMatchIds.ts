// Reads the identifiers the matcher uses out of stored rows. Pure, no database.

/** ASINs from OrderPackage.itemsJson ([{title, asin?, quantity}]); unreadable JSON gives none. */
export function orderAsins(itemsJson: readonly (string | null | undefined)[]): string[] {
  const out = new Set<string>();
  for (const raw of itemsJson) {
    try {
      const items: unknown = JSON.parse(raw || '[]');
      if (!Array.isArray(items)) continue;
      for (const it of items) {
        const asin = typeof it === 'object' && it ? (it as { asin?: unknown }).asin : null;
        if (typeof asin === 'string' && /^B0[A-Z0-9]{8}$/i.test(asin.trim())) out.add(`asin:${asin.trim().toUpperCase()}`);
      }
    } catch { /* not JSON: no ids */ }
  }
  return [...out];
}

/** item_model_number from a BFMR reservation's raw JSON, or null. */
export function bfmrModelNumber(raw: string | null | undefined): string | null {
  try {
    const d: unknown = JSON.parse(raw || 'null');
    const m = typeof d === 'object' && d ? (d as { item_model_number?: unknown }).item_model_number : null;
    return typeof m === 'string' && m.trim() ? m.trim() : null;
  } catch { return null; }
}

/** Only the lines whose reason differs from the last one logged for that order. Updates the memory. */
export function changedLines(userId: number, lines: readonly string[], seen: Map<string, string>): string[] {
  const out: string[] = [];
  for (const l of lines) {
    const m = /^order (\d+): (.*)$/.exec(l);
    if (!m) continue;
    const k = `${userId}:${m[1]}`;
    if (seen.get(k) === m[2]) continue;
    seen.set(k, m[2]);
    out.push(l);
  }
  return out;
}

