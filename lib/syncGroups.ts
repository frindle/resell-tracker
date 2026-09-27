// What the Orders page's "Resync Groups" button fires, besides its
// server-side group syncs (BG receipts, BFMR API full-sync, CardCenter,
// BigSky).
//
// These are ExtensionCommand types queued for the headless sidecar, the
// same way the per-retailer Sync Amazon / Walmart / Costco / BFMR buttons
// queue them. The sidecar claims each one and moves it
// pending -> running -> done|failed, and the corner SyncStatusIndicator
// reports every transition. A failure that means "log in again" (see
// isSessionExpiredResult in lib/syncStatus.ts) gets the same
// "connect to sidecar" link as an Amazon or Walmart session error.
//
// Only group sites belong here. Amazon, Walmart and Costco are retailers
// with their own Sync buttons and are not part of the group resync.

import type { ExtensionCommandType } from './extensionCommandTypes.ts';

export const RESYNC_GROUPS_SIDECAR_COMMANDS = ['SYNC_BFMR'] as const satisfies readonly ExtensionCommandType[];

/**
 * POST /api/extension/commands bodies for the Resync Groups sidecar
 * commands. Always targeted at 'sidecar': an untargeted command can be
 * claimed by any installed browser extension (see syncPlatform() in
 * app/orders/page.tsx).
 */
export function resyncGroupsSidecarRequests(): { type: ExtensionCommandType; targetBrowser: 'sidecar' }[] {
  return RESYNC_GROUPS_SIDECAR_COMMANDS.map(type => ({ type, targetBrowser: 'sidecar' as const }));
}
