// Pick which of several orders a BFMR line belongs to when they share one
// tracking number, by item-name overlap. Pure, unit tested.
//
// Orders 759 (AirPods Pro 3) and 772 (iPad Pro) shipped in one Amazon box
// under TBA332369944531. BFMR's iPad tracker row carried only that tracking,
// and both the auto-linker and the tracker sync took the FIRST order holding
// it -- so 759 was credited $2610 of iPad payout ($3507 vs a true $897) and
// 772 came up $2610 short.
const STOP = new Set(['apple', 'with', 'and', 'the', 'for', 'new', 'usb', 'charging', 'case', 'model', 'inch', 'wireless', 'latest']);
const tokens = (s: string | null | undefined) =>
  new Set((s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter(w => w.length >= 3 && !STOP.has(w)));

// One candidate: returned as-is (no ambiguity). Several: the unique best
// positive overlap wins; a tie or no overlap returns undefined and callers
// fall back to their previous first-match choice (no behaviour change).
export function pickByItem<T>(candidates: T[], itemName: string | null | undefined, descOf: (c: T) => string | null | undefined): T | undefined {
  if (candidates.length <= 1) return candidates[0];
  const want = tokens(itemName);
  let best: T | undefined;
  let bestScore = 0;
  let tie = false;
  for (const c of candidates) {
    let score = 0;
    for (const w of tokens(descOf(c))) if (want.has(w)) score++;
    if (score > bestScore) { best = c; bestScore = score; tie = false; }
    else if (score === bestScore && score > 0) tie = true;
  }
  return bestScore > 0 && !tie ? best : undefined;
}
