// Pure BG-credited decision logic, split out of lib/bgSync.ts so it can be
// unit tested with the repo's node --test runner (bgSync.ts pulls in prisma
// and the BG API client, which aren't part of that suite).
//
// Real (non-type-only) imports below use explicit .ts extensions —
// lib/bgCredited.test.ts runs on Node's built-in test runner with type
// stripping, which needs extension-bearing ESM specifiers to resolve these
// at runtime (see the allowImportingTsExtensions note in tsconfig.json).

/**
 * An order is BG-credited only when EVERY one of its shipments has an
 * in-balance receipt. The old sync logic flipped bgCredited on the FIRST
 * in-balance receipt for the order, so a 2-package order with just one
 * credited package (order 899) wrongly showed "BG Credited: yes".
 *
 * @param orderTrackings   the order's distinct shipment tracking tokens.
 * @param creditedTrackings the tracking tokens that received an in-balance
 *                          receipt this sync.
 * @returns true only when there is at least one shipment AND every one of
 *          `orderTrackings` is present in `creditedTrackings`. An empty
 *          `orderTrackings` list means nothing to credit, so it returns false.
 */
export function isOrderFullyCredited(
  orderTrackings: string[],
  creditedTrackings: Set<string>,
): boolean {
  if (orderTrackings.length === 0) return false;
  return orderTrackings.every((t) => creditedTrackings.has(t));
}
