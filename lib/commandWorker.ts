// Which worker handles which command type. One place, used wherever a command
// is queued, so a button, the email import and a retry can't disagree.
//
//   extension: the owner's own browser (polls as 'chrome'). Amazon and Costco:
//              the owner is already signed in there. The sidecar could never
//              sign in to Costco.
//   sidecar:   the headless browser. Walmart, BFMR, cashback and MGCP scrapes.
//   null:      no fixed worker (SYNC_BIGSKY): left untargeted so a real
//              extension can claim it.

import { AMAZON_COMMAND_TYPES, AMAZON_EXTENSION_TARGET, COSTCO_COMMAND_TYPES } from './amazonSync.ts';

export type CommandWorker = 'extension' | 'sidecar';

const EXTENSION_TYPES: ReadonlySet<string> = new Set([...AMAZON_COMMAND_TYPES, ...COSTCO_COMMAND_TYPES]);
const SIDECAR_TYPES: ReadonlySet<string> = new Set([
  'SYNC_WALMART', 'SYNC_WALMART_ORDER', 'SYNC_BFMR', 'SCRAPE_CBM', 'SCRAPE_MGCP',
]);

export function commandWorker(type: string): CommandWorker | null {
  if (EXTENSION_TYPES.has(type)) return 'extension';
  if (SIDECAR_TYPES.has(type)) return 'sidecar';
  return null;
}

/** The targetBrowser value to queue this type with, or null to leave it untargeted. */
export function commandTarget(type: string): string | null {
  const w = commandWorker(type);
  return w === 'extension' ? AMAZON_EXTENSION_TARGET : w === 'sidecar' ? 'sidecar' : null;
}

/** True for the Costco types, which a stale sidecar-targeted row must be moved off. */
export function isCostcoCommand(type: string): boolean {
  return (COSTCO_COMMAND_TYPES as readonly string[]).includes(type);
}
