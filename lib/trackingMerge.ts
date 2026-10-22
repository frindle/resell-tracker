// Merge an incoming scraped tracking list into the stored comma-separated list.
export interface TrackingMergeResult {
  list: string
  added: boolean
}

export function mergeTracking(existing: string | null, incoming: string | null, incomplete: boolean): TrackingMergeResult {
  const parse = (s: string | null): string[] =>
    s ? s.split(',').map(p => p.trim()).filter(p => p.length > 0) : [];

  const existingList = parse(existing);
  const incomingList = parse(incoming);

  if (incomplete) {
    // Union: existing first in original order, then new incoming in incoming order
    const seen = new Set<string>();
    const result: string[] = [];

    for (const item of existingList) {
      const key = item.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        result.push(item);
      }
    }

    let added = false;
    for (const item of incomingList) {
      const key = item.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        result.push(item);
        added = true;
      }
    }

    return { list: result.join(','), added };
  } else {
    // incomplete=false
    if (incomingList.length === 0) {
      return { list: existingList.join(','), added: false };
    }

    // Result is the incoming list (order and case of the incoming text), de-duplicated
    // case-insensitively; `added` only when a number is new to the existing list.
    const existingLower = new Set(existingList.map(item => item.toLowerCase()));

    const seen = new Set<string>();
    const result: string[] = [];
    let added = false;

    for (const item of incomingList) {
      const key = item.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(item);
      if (!existingLower.has(key)) added = true;
    }

    return { list: result.join(','), added };
  }
}
