// The command types POST /api/extension/commands will queue, pulled out of
// app/api/extension/commands/route.ts so the allow-list is testable without
// a database -- route.ts imports and uses this directly (not a copy).
//
// Adding a type here only lets the app QUEUE it; something still has to
// claim it. The headless sidecar's handlers live in sidecar/src/poll.js's
// SITES map, and anything it does not implement (SYNC_BIGSKY) is left for a
// real browser extension to pick up.

export const EXTENSION_COMMAND_TYPES = [
  'SYNC_AMAZON',
  'SYNC_WALMART',
  'SYNC_COSTCO',
  'SYNC_BFMR',
  'SYNC_BIGSKY',
  'SCRAPE_CBM',
  'SYNC_AMAZON_ORDER',
] as const;

export type ExtensionCommandType = (typeof EXTENSION_COMMAND_TYPES)[number];

export function isExtensionCommandType(type: string): type is ExtensionCommandType {
  return (EXTENSION_COMMAND_TYPES as readonly string[]).includes(type);
}
