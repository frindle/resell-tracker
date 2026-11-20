// Amazon is read by the browser extension only (the sidecar no longer touches
// it). Every Amazon command is targeted at the extension, which polls as
// 'chrome' (the Brave extension).
export const AMAZON_EXTENSION_TARGET = 'chrome';

/** Amazon command types the extension runs. Anything pending for one of these on the sidecar is moved to the extension. */
export const AMAZON_COMMAND_TYPES = ['SYNC_AMAZON', 'SYNC_AMAZON_PAGES', 'SYNC_AMAZON_ORDER', 'TRACK_AMAZON', 'VISIT_AMAZON'] as const;

/** What the "Sync Amazon" buttons queue: a command for the browser extension. */
export const AMAZON_BUTTON_COMMAND = { type: 'SYNC_AMAZON_PAGES', targetBrowser: AMAZON_EXTENSION_TARGET } as const;
export const AMAZON_BUTTON_HINT =
  'Queued for your browser extension, which opens Your Orders and reads the pages. If nothing opens, the extension is not connected: open amazon.com/your-orders yourself and the extension will pick the pages up as you browse.';
