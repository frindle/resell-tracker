// What the Orders page's "Resync Groups" button fires, besides its
// server-side group syncs (BG receipts, BFMR API full-sync, CardCenter,
// BigSky).
//
// BFMR's tracker rows now come over the API (bfmrTrackerOutcome below); the
// sidecar command is queued only as the fallback when that fails.
//
// These are ExtensionCommand types queued for the headless sidecar, the
// same way the per-retailer Sync Amazon / Walmart / Costco buttons queue
// them. (There is no separate "Sync BFMR" button on the Orders page any
// more: Resync Groups is the one place that queues SYNC_BFMR there.) The sidecar claims each one and moves it
// pending -> running -> done|failed, and the corner SyncStatusIndicator
// reports every transition. A failure that means "log in again" (see
// isSessionExpiredResult in lib/syncStatus.ts) gets the same
// "connect to sidecar" link as an Amazon or Walmart session error.
//
// Resync Groups also follows the queued command to its end for a short while
// (see sidecarOutcome below) so a "log in again" failure is shown inline
// instead of only in the corner indicator.
//
// Only group sites belong here. Amazon, Walmart and Costco are retailers
// with their own Sync buttons and are not part of the group resync.

import type { ExtensionCommandType } from './extensionCommandTypes.ts';
import { isActiveCommand, isSessionExpiredResult, summarizeResult, type ExtCommand } from './syncStatus.ts';

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

/** How long Resync Groups follows the queued sidecar command, and how often. */
export const SIDECAR_POLL_TIMEOUT_MS = 75_000;
export const SIDECAR_POLL_INTERVAL_MS = 3_000;

export type SidecarOutcome = {
  /** Status-line fragment, e.g. "BFMR sidecar: done — 3 new". */
  text: string;
  /** True when the command is still pending/running (keep polling). */
  active: boolean;
  /** True when the failure means "log in again on the sidecar" -- the page
   *  renders the same connect-to-sidecar / set-up-sidecar link as the
   *  Amazon/Walmart session errors. */
  needsLogin: boolean;
};

/**
 * Turns the latest known state of the queued SYNC_BFMR command into the
 * Resync Groups status fragment.
 *
 * `command` is null when it could not be read back (the queue GET failed or
 * the row is gone); `timedOut` means the poll budget ran out. A command that
 * is still active at that point is not an error -- it keeps going and the
 * corner indicator keeps reporting it.
 */
export function sidecarOutcome(
  command: Pick<ExtCommand, 'status' | 'result'> | null,
  timedOut = false,
): SidecarOutcome {
  const label = 'BFMR sidecar';
  if (!command) {
    return { text: `${label}: queued — progress shows in the corner indicator`, active: false, needsLogin: false };
  }
  if (isActiveCommand(command)) {
    if (timedOut) {
      return { text: `${label}: still ${command.status === 'running' ? 'running' : 'queued'} — it continues in the corner indicator`, active: true, needsLogin: false };
    }
    return { text: `${label}: ${command.status === 'running' ? 'running…' : 'queued…'}`, active: true, needsLogin: false };
  }
  const summary = summarizeResult(command.result);
  if (command.status === 'failed') {
    if (isSessionExpiredResult(command.result)) {
      return { text: `${label}: session expired — log in again`, active: false, needsLogin: true };
    }
    return { text: `${label}: failed${summary ? ` — ${summary}` : ''}`, active: false, needsLogin: false };
  }
  if (command.status === 'done') {
    return { text: `${label}: done${summary ? ` — ${summary}` : ''}`, active: false, needsLogin: false };
  }
  return { text: `${label}: ${command.status}`, active: false, needsLogin: false };
}

export type BfmrTrackerApiResult = { ok: boolean; body: { webError?: string; webBackfilled?: number; synced?: number } | null };

/**
 * Resync Groups pulls BFMR's tracker rows (myTrackerId backfill) over the API
 * now: since the TLS-fingerprint fix the server reaches www.bfmr.com itself
 * with its stored web session. The sidecar's real browser is only the
 * fallback, for when that session can't be used (expired JWT -- BFMR's login
 * is reCAPTCHA-gated, so only a browser can mint a new one) or the call fails.
 */
export function bfmrTrackerOutcome(res: BfmrTrackerApiResult): { text: string; needsSidecar: boolean } {
  if (!res.ok || !res.body) return { text: 'BFMR tracker: API failed — using sidecar', needsSidecar: true };
  if (res.body.webError) return { text: 'BFMR tracker: API session unavailable — using sidecar', needsSidecar: true };
  const n = res.body.webBackfilled ?? 0;
  return { text: `BFMR tracker (API): ${n ? `${n} linked` : 'up to date'}`, needsSidecar: false };
}
