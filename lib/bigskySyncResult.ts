// Turns the reply of POST /api/bigsky/sync-commitments into the message the
// pages show. Pure, so the wording and the non-JSON fallback are testable.

export type SyncReply = { synced?: number; skipped?: number; fulfillmentsWithoutTracking?: number; error?: string };

export function parseSyncReply(status: number, text: string): SyncReply {
  try {
    const d = JSON.parse(text) as unknown;
    if (d && typeof d === 'object') return d as SyncReply;
  } catch { /* fall through */ }
  return { error: `Sync failed: HTTP ${status} (non-JSON response)` };
}

export function syncMessage(d: SyncReply): { ok: boolean; text: string } {
  if (d.error) return { ok: false, text: d.error };
  const notes = [
    d.skipped ? `${d.skipped} unreadable` : '',
    d.fulfillmentsWithoutTracking ? `${d.fulfillmentsWithoutTracking} fulfillments with no scan found` : '',
  ].filter(Boolean).join(', ');
  return { ok: true, text: `Synced ${d.synced ?? 0} commitments${notes ? ` (${notes})` : ''}` };
}
