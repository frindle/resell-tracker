// Pure logic for reconciling BFMR's two ID spaces. No imports on purpose:
// this is the part that has to be exercisable against a captured pair of
// live rows without dragging in the DB, the session cache, or fetch.

export type TrackerRow = {
  id: number;
  // null on a reservation that has not been purchased yet -- was typed as a
  // bare number, which made "PID is absent" unrepresentable.
  PID: number | null;
  RID?: number;
  SID?: number | null;
  type: string;
  force_delete_shipment_after_deadline?: number;
  item_id: number;
  item_name?: string;
  item_model_number?: string | null;
  qty: string;
  my_tracker_id: number;
  notes: string;
  order_id: string | null;
  tracking_number: string;
  deal_id: number;
  has_custom_columns: number;
  is_bundle: number;
  amount_paid: string;
  paid_at: string;
  qty_received: string;
  reserved_at: string;
  retail_price: number;
  scanned_at: string;
  status: string;
  sub_total: number;
  [key: string]: unknown;
};

// ---------------------------------------------------------------------------
// Joining BFMR's two surfaces
//
// There is NO shared identifier. Measured live 2026-08-25 on the same
// reservation, side by side:
//
//   REST (api.bfmr.com/v2)              Web App (www.bfmr.com/api)
//   reserve_id "DWA8k2LGI9yvcXbORTDbrQ==" RID          1841666
//   purchase_id null                      PID          null
//   deal_id    "d6oTuw8sNqV8U6MT2UtKNw==" deal_id      9645
//   item_id    "fB2cRYGjxfvwViKf4N34SA==" item_id      9042
//   (my_tracker_id absent entirely)       my_tracker_id 4901929
//   reserved_at "08/25/2026 12:05:05"     reserved_at  "2026-08-25 12:05:05"
//   qty        "2"                        qty          "2"
//   order_id   null                       order_id     null
//   item_model_number "MX2D3AM/A"         item_model_number "MX2D3AM/A"
//   retail_price 97                       retail_price 97
//
// The old sync joined on `order_id|item_id|qty`, which could never match:
// item_id is base64 on one side and an integer on the other. The fields that
// DO join are reserved_at (same instant, different format), the item
// model/name, qty, and order_id.
//
// Measured over the full account (748 REST rows x 453 Web rows): this key
// resolves 438 rows to exactly one match, 15 ambiguously, 295 to nothing
// (almost all of them older than the 12-month window BFMR will serve).
// Dropping the item field pushes ambiguity from 15 to 78; dropping order_id
// pushes it to 55. Both stay in.
//
// Ambiguity is NOT resolved by picking one — two genuinely different
// reservations under one order, same item, reserved in the same second, with
// the same qty are indistinguishable here, and guessing is exactly the
// wrong-reservation bug this codebase already paid for once. Zero or >1
// match means the field stays null and the sync says so.
// ---------------------------------------------------------------------------

/** "08/25/2026 12:05:05" and "2026-08-25 12:05:05" both -> "2026-08-25T12:05:05". */
export function normalizeBfmrTimestamp(v: unknown): string {
  const t = String(v ?? '').trim();
  if (!t) return '';
  const iso = t.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}T${iso[4]}:${iso[5]}:${iso[6]}`;
  const us = t.match(/^(\d{2})\/(\d{2})\/(\d{4})[T ](\d{2}):(\d{2}):(\d{2})/);
  if (us) return `${us[3]}-${us[1]}-${us[2]}T${us[4]}:${us[5]}:${us[6]}`;
  return t;
}

/** Join key over the fields both surfaces agree on. Same shape for both sides. */
export function bfmrJoinKey(row: {
  reserved_at?: unknown;
  item_model_number?: unknown;
  item_name?: unknown;
  qty?: unknown;
  order_id?: unknown;
}): string {
  const item = String(row.item_model_number || row.item_name || '').trim().toLowerCase();
  const qty = parseInt(String(row.qty ?? ''), 10);
  return [
    normalizeBfmrTimestamp(row.reserved_at),
    item,
    Number.isNaN(qty) ? '' : String(qty),
    String(row.order_id ?? ''),
  ].join('|');
}

/**
 * Group key for a SPLIT commitment: the two fields a split cannot change.
 *
 * Deliberately drops qty AND order_id -- those are exactly the fields that vary
 * between halves of one split, which is why bfmrJoinKey (which keeps both, on
 * purpose, for the 1:1 case) can never resolve one.
 */
export function bfmrSplitGroupKey(row: {
  reserved_at?: unknown;
  item_model_number?: unknown;
  item_name?: unknown;
}): string {
  const item = String(row.item_model_number || row.item_name || '').trim().toLowerCase();
  return [normalizeBfmrTimestamp(row.reserved_at), item].join('|');
}

/**
 * Resolve split commitments: local rows whose qtys SUM to one web row's qty.
 *
 * A BFMR commitment split across >1 local reservation rows is ONE web row (one
 * my_tracker_id) whose quantity was divided. Each half carries a partial qty and
 * its own order_id, so each half matches the web row on neither -- leaving
 * myTrackerId null forever and every tracking submit 409ing.
 *
 * Only groups of >= 2 locals are considered: a lone row is the ordinary 1:1
 * path's business, and both paths claiming one row would silently double up the
 * "exactly one match" discipline.
 *
 * Zero or >1 candidate web rows resolves to NOTHING. Two genuinely different
 * commitments at the same instant, same item, same summed qty are
 * indistinguishable here, and guessing is the wrong-reservation bug this module
 * already paid for once.
 */
export function matchSplitGroups(
  locals: Array<{
    id: number;
    reserved_at?: unknown;
    item_model_number?: unknown;
    item_name?: unknown;
    qty?: unknown;
  }>,
  webRows: Array<{
    reserved_at?: unknown;
    item_model_number?: unknown;
    item_name?: unknown;
    qty?: unknown;
    my_tracker_id?: unknown;
  }>,
): Array<{ id: number; my_tracker_id: number }> {
  const groups = new Map<string, typeof locals>();
  for (const l of locals || []) {
    const k = bfmrSplitGroupKey(l);
    const g = groups.get(k);
    if (g) g.push(l); else groups.set(k, [l]);
  }
  const out: Array<{ id: number; my_tracker_id: number }> = [];
  for (const [key, group] of groups) {
    if (group.length < 2) continue;                 // 1:1 is the other path's job
    let sum = 0;
    let ok = true;
    for (const l of group) {
      const q = parseInt(String(l.qty ?? ''), 10);
      if (Number.isNaN(q)) { ok = false; break; }
      sum += q;
    }
    if (!ok) continue;
    const candidates = (webRows || []).filter(w => {
      const wq = parseInt(String(w.qty ?? ''), 10);
      return bfmrSplitGroupKey(w) === key && !Number.isNaN(wq) && wq === sum
        && w.my_tracker_id != null && Number(w.my_tracker_id) > 0;
    });
    if (candidates.length !== 1) continue;          // 0 or ambiguous -> stay null
    const tid = Number(candidates[0].my_tracker_id);
    for (const l of group) out.push({ id: l.id, my_tracker_id: tid });
  }
  return out;
}

export function buildOrderIdTrackerRow(
  match: TrackerRow,
  qty: number,
  orderNumber: string,
): Record<string, unknown> {
  // For a row that has been purchased: type=purchased, id=PID.
  // For one still reserved (no PID yet): type=reservation, id=RID.
  const isPurchased = match.PID != null && match.status !== 'reserved';
  return {
    qty,                                   // NUMBER, and a reduction here IS the split
    id: isPurchased ? match.PID : (match.RID ?? match.id),
    PID: match.PID ?? null,
    RID: match.RID ?? match.id,
    SID: match.SID ?? null,
    my_tracker_id: match.my_tracker_id,
    deal_id: match.deal_id,                // numeric on this surface (e.g. 9645)
    item_id: match.item_id,                // numeric on this surface (e.g. 9042)
    type: isPurchased ? 'purchased' : 'reservation',
    status: match.status,
    retail_price: match.retail_price,
    rowIndex: 0,
    order_id: orderNumber,
    tracking_number: match.tracking_number ?? '',
  };
}
