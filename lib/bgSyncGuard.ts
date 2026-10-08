// Refuse to treat "BuyingGroup returned nothing" as a successful sync when we
// already hold rows for the user: an empty upstream answer over a populated
// local table is far more likely an upstream fault than every commitment
// vanishing at once, and a silent {synced:0} hides it. Pure so it can be
// unit-tested without the route's db/auth dependencies (Next route files may
// not export extra names, so this lives here rather than in route.ts).
export function checkSyncGuard(bgCommitmentsLength: number, existingRowsLength: number): Response | null {
  if (bgCommitmentsLength !== 0 || existingRowsLength <= 0) return null;
  const error = `BG returned 0 commitments but ${existingRowsLength} are stored; refusing to treat as a successful sync`;
  console.log(`[bg/sync-commitments] ${error}`);
  return Response.json({ error }, { status: 502 });
}
