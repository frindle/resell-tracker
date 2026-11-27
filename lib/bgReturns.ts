// Buying Group return tasks (POST /task/get_tasks, the data behind BG's Returns page). Pure: no imports,
// unit tested. The sync that stores them is lib/bgReturnsRun.ts.

export type BgTask = {
  key: string;
  receiptId: string | null;   // R-... on BG's side
  sku: string | null;
  serial: string | null;
  status: string;             // normalised: READY, LABEL, SENT, TICKET, RESOLVED, ACCEPTED_WITHOUT_DISCOUNT ...
  voided: boolean;
  supportId: string | null;
  tracking: string | null;    // the tracking BG received the parcel on
  note: string | null;
  imageCount: number;
  createdDt: string | null;
  updatedDt: string | null;
};

const str = (v: unknown): string | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t && t !== '---' ? t : null;
};
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});

/** "Accepted Without Discount", "accepted_without_discount" -> ACCEPTED_WITHOUT_DISCOUNT. */
export function normalizeStatus(s: unknown): string {
  return String(s ?? '').trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '');
}

/** One row of the get_tasks payload, or null when it has no key. Unknown fields are ignored. */
export function parseTask(raw: unknown): BgTask | null {
  const t = obj(raw);
  const key = str(t.key) ?? str(t.task_id) ?? str(t.id);
  if (!key) return null;
  const receipt = obj(t.receipt);
  const item = obj(t.item);
  const images = Array.isArray(t.images) ? t.images.length : typeof t.images === 'string' && t.images.trim().startsWith('[') ? safeLen(t.images) : 0;
  return {
    key,
    receiptId: str(receipt.receipt_id) ?? str(t.receipt_id),
    sku: str(item.item_id) ?? str(t.sku),
    serial: (str(item.item_serial) ?? str(t.serial))?.replace(/\s*-+\s*$/, '').trim() || null,
    status: normalizeStatus(t.task_status ?? t.status),
    voided: t.void === true,
    supportId: str(t.ticket_id),
    tracking: str(receipt.tracking_id) ?? str(t.tracking_id),
    note: str(t.note),
    imageCount: images,
    createdDt: str(t.created_dt),
    updatedDt: str(t.updated_dt),
  };
}

function safeLen(json: string): number {
  try { const a: unknown = JSON.parse(json); return Array.isArray(a) ? a.length : 0; } catch { return 0; }
}

export type TaskKind =
  | { kind: 'return'; status: 'requested' | 'in_transit' | 'received' }
  | { kind: 'accepted'; effect: string }
  | { kind: 'void' }
  | { kind: 'other' };

/**
 * What a task means for the order. READY, LABEL and TICKET: BG wants the unit back and it has not
 * shipped. SENT: on its way. RESOLVED: back and closed (refund amount unknown, so "received").
 * ACCEPTED_*: BG keeps the item, so NOT a return; the payout effect is recorded instead.
 */
export function classifyTask(t: Pick<BgTask, 'status' | 'voided' | 'note'>): TaskKind {
  if (t.voided || t.status === 'VOIDED') return { kind: 'void' };
  switch (t.status) {
    case 'READY': case 'LABEL': case 'TICKET': return { kind: 'return', status: 'requested' };
    case 'SENT': return { kind: 'return', status: 'in_transit' };
    case 'RESOLVED': return { kind: 'return', status: 'received' };
    case 'ACCEPTED_WITHOUT_DISCOUNT': return { kind: 'accepted', effect: 'Accepted without discount: BG keeps the item and pays as committed' };
    case 'ACCEPTED_WITH_DISCOUNT': return { kind: 'accepted', effect: 'Accepted with a discount: BG pays less than committed' };
    default: return { kind: 'other' };
  }
}

/** Tracking numbers compared on their last 12 characters (carriers add or drop prefixes), letters upper-cased. */
export function trackingKey(t: string | null | undefined): string | null {
  const c = (t ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return c.length >= 8 ? c.slice(-12) : null;
}

export type MatchableOrder = { id: number; tracking: string[]; skus: string[] };
export type TaskMatch = { orderId: number; by: 'tracking' | 'serial' | 'sku' } | null;

/**
 * An order for a task: exact tracking first (when several orders share it, the one whose BG item is the
 * task's SKU; still several = no match), then an earlier task with the same serial that was matched, then
 * a SKU that exactly one order carries. Never guesses between orders.
 */
export function matchTask(
  task: Pick<BgTask, 'tracking' | 'serial' | 'sku'>,
  orders: readonly MatchableOrder[],
  serialOwner: ReadonlyMap<string, number> = new Map(),
): TaskMatch {
  const tk = trackingKey(task.tracking);
  if (tk) {
    let hit = orders.filter(o => o.tracking.some(t => trackingKey(t) === tk));
    if (hit.length > 1 && task.sku) hit = hit.filter(o => o.skus.includes(task.sku!));
    if (hit.length === 1) return { orderId: hit[0].id, by: 'tracking' };
    if (hit.length > 1) return null;
  }
  const owner = task.serial ? serialOwner.get(task.serial) : undefined;
  if (owner != null) return { orderId: owner, by: 'serial' };
  if (task.sku) {
    const hit = orders.filter(o => o.skus.includes(task.sku!));
    if (hit.length === 1) return { orderId: hit[0].id, by: 'sku' };
  }
  return null;
}

export type SyncedReturnRow = {
  status: string; refundAmount: number | null; returnTracking: string | null; notes: string | null;
  quantity: number; receivedAt: Date | null; refundedAt: Date | null;
};
export const AUTO_NOTE = 'Auto-recorded from Buying Group returns';

/** True while a person has not touched a row the sync made: only it may be deleted or moved by a later sync. */
export function isUntouchedSyncRow(r: SyncedReturnRow): boolean {
  return ['requested', 'in_transit', 'received'].includes(r.status)
    && r.refundAmount == null && !r.returnTracking && r.quantity === 1 && r.receivedAt == null && r.refundedAt == null
    && (r.notes ?? '').startsWith(AUTO_NOTE);
}
