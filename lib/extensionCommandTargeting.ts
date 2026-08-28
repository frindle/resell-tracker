// The GET /api/extension/commands "which caller sees which pending
// command" rule, pulled out of app/api/extension/commands/route.ts so it's
// one piece of testable logic instead of an inline Prisma `where` object --
// route.ts imports and uses this directly (not a copy).
//
// The bug this exists to prevent: app/orders/page.tsx's syncPlatform() (and
// app/settings/page.tsx's queueExtCmd()) used to POST a command with no
// targetBrowser at all. An untargeted command (targetBrowser: null) is
// claimable by ANY poller -- including a real installed browser extension
// sending X-Extension-Browser: chrome/firefox, not just the headless
// sidecar (which sends 'sidecar'). That let clicking Sync in the tracker UI
// open a live Amazon/Walmart/Costco tab on whatever machine still had the
// extension installed. UI-triggered commands now set targetBrowser:
// 'sidecar' explicitly (except SYNC_BIGSKY, which the sidecar doesn't
// implement -- see app/settings/page.tsx's SIDECAR_HANDLED_TYPES -- so it's
// left untargeted on purpose, and this filter still needs to let it
// through to a real extension poller).

export type ExtensionCommandTargetFilter = {
  OR: ({ targetBrowser: null } | { targetBrowser: string })[];
};

/**
 * Builds the Prisma `where` fragment for "commands this caller may claim":
 * untargeted commands, plus any targeted specifically at this caller's
 * browser identity (the sidecar sends 'sidecar'; a real extension sends
 * 'chrome' or 'firefox').
 */
export function extensionCommandTargetFilter(callerBrowser: string | null): ExtensionCommandTargetFilter {
  return {
    OR: [
      { targetBrowser: null },
      ...(callerBrowser ? [{ targetBrowser: callerBrowser }] as const : []),
    ],
  };
}

/** Pure version of the same rule, for asserting against a single command without a database. */
export function callerCanClaim(commandTargetBrowser: string | null, callerBrowser: string | null): boolean {
  return commandTargetBrowser === null || commandTargetBrowser === callerBrowser;
}
