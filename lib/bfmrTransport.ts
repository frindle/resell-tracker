// BFMR write-transport switch. Setting `bfmr_write_transport` = 'rest' routes
// writes through the REST v2 API; anything else (including unset) keeps the
// legacy web path. Pure on purpose. Removed in U10.
export function isRestWrites(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim().toLowerCase() === 'rest';
}

// The web tracker-ID backfill logs into BFMR's website, which is
// reCAPTCHA-gated (the server's login gets a 403). With REST writes on,
// submits target a line by purchaseId and never need myTrackerId, so the
// login is skipped. Rows posted by the sidecar (a real browser session) are
// still used.
export function shouldRunWebBackfill(o: {
  planRuns: boolean; needed: number; restWrites: boolean; hasSidecarRows: boolean;
}): boolean {
  if (!o.planRuns || o.needed <= 0) return false;
  return o.hasSidecarRows || !o.restWrites;
}
