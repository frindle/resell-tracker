// BuyingGroup "Tiered Payout" deals pay more for faster delivery: a commitment carries payout_tiers such as
// Base (price + $2, deliver by Dec 28) and Priority (price + $11, deliver by Dec 4). While the commitment is
// open BG reports the Base commission; once the units are in, BG moves the commitment's commission to the
// tier they earned, and the commitment sync re-prices the linked orders from that.
//
// This file reads the tiers from the stored BG record and answers two questions:
//   - which faster tier can an open commitment still reach (shown on the commitments page), and
//   - did BG pay the tier a delivery earned (a commitment BG itself marked fulfilled before a tier's
//     deadline but still paying less than that tier).
// Tiers for using a BG shipping label ("10+ BG Label") pay by label use, not speed, so they never count as
// earned and a commission matching one is never called short.

export type BgTier = {
  label: string;
  price: number;
  commission: number;
  deliverBy: Date;
  isBase: boolean;
  isLabel: boolean;
};

const CENT = 0.005;

// Commitment tiers give deliver_by as "MM-DD-YYYY HH:MM:SS" in UTC ("12-05-2026 07:59:59" is the end of
// Dec 4 Pacific, which the deal page shows as "12-04-2026 23:59:59").
export function parseBgTierTime(s: unknown): Date | null {
  if (typeof s !== 'string') return null;
  const m = s.match(/^(\d{2})-(\d{2})-(\d{4})[ ,T]+(\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return null;
  const [, mm, dd, yyyy, h, min, sec] = m;
  const d = new Date(`${yyyy}-${mm}-${dd}T${h}:${min}:${sec}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

// The tiers on a stored BG commitment record (BuyingGroupCommitment.raw), soonest deadline first.
export function bgPayoutTiers(raw: string | null | undefined): BgTier[] {
  if (!raw) return [];
  let rec: unknown;
  try { rec = JSON.parse(raw); } catch { return []; }
  const list = (rec as { payout_tiers?: unknown } | null)?.payout_tiers;
  if (!Array.isArray(list)) return [];
  const tiers: BgTier[] = [];
  for (const t of list) {
    if (!t || typeof t !== 'object') continue;
    const r = t as Record<string, unknown>;
    const deliverBy = parseBgTierTime(r.deliver_by);
    const price = Number(r.price);
    const commission = Number(r.commission);
    if (!deliverBy || !Number.isFinite(price) || !Number.isFinite(commission)) continue;
    const label = typeof r.label === 'string' ? r.label : '';
    tiers.push({
      label, price, commission, deliverBy,
      isBase: r.is_base === true,
      isLabel: r.is_bg_label === true || /\bbg\s*label\b/i.test(label),
    });
  }
  return tiers.sort((a, b) => a.deliverBy.getTime() - b.deliverBy.getTime());
}

// Speed tiers only: Base plus any tier paid for delivering by a date.
const speedTiers = (tiers: readonly BgTier[]) => tiers.filter(t => !t.isLabel);

// The best-paying tier a delivery at `at` earns, or null when it misses every deadline.
export function tierEarned(tiers: readonly BgTier[], at: Date): BgTier | null {
  let best: BgTier | null = null;
  for (const t of speedTiers(tiers)) {
    if (t.deliverBy.getTime() < at.getTime()) continue;
    if (!best || t.price + t.commission > best.price + best.commission + CENT) best = t;
  }
  return best;
}

// A tier above what the commitment pays now that a delivery by `now` would still earn: the upside to show
// on an open commitment. Null when the commitment has no faster tier or its deadline has passed.
export function reachableTier(tiers: readonly BgTier[], commission: number, now: Date): BgTier | null {
  const t = tierEarned(tiers, now);
  return t && !t.isBase && t.commission > commission + CENT ? t : null;
}

// BG marked the commitment fulfilled at `fulfilledAt` (the sync that first saw every unit in) yet pays less
// than the tier that date earned. Null when paid right, when no faster tier exists, or when the commission
// matches a BG-label tier (the units may have gone on BG's label).
export function underpaidTier(tiers: readonly BgTier[], commission: number, fulfilledAt: Date): BgTier | null {
  if (!speedTiers(tiers).some(t => !t.isBase)) return null;
  if (tiers.some(t => t.isLabel && Math.abs(t.commission - commission) < CENT)) return null;
  const t = tierEarned(tiers, fulfilledAt);
  return t && t.commission > commission + CENT ? t : null;
}

// How long after BG marks a commitment fulfilled it gets to move the commission before we call it short.
export const TIER_GRACE_MS = 24 * 60 * 60 * 1000;

export function tierShortText(dealTitle: string, commitmentId: string, paid: number, earned: BgTier, units: number, fulfilledAt: Date): string {
  const per = earned.commission - paid;
  const day = fulfilledAt.toISOString().slice(0, 10);
  return `${dealTitle.slice(0, 60)} (${commitmentId}): BuyingGroup marked it fulfilled ${day}, inside the ${earned.label} deadline, ` +
    `but pays $${paid.toFixed(2)} commission instead of $${earned.commission.toFixed(2)}. ` +
    `Short $${(per * units).toFixed(2)} on ${units} unit${units === 1 ? '' : 's'}.`;
}
