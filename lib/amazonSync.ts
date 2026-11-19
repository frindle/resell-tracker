// Amazon shows the headless sidecar an "unauthorized AI agent" page, so
// sidecar Amazon sync is off unless SIDECAR_AMAZON_ENABLED=1. Amazon orders
// are captured by the browser extension from pages the user opens or from a
// "Sync now" click (SYNC_AMAZON_PAGES).
export function sidecarAmazonEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.SIDECAR_AMAZON_ENABLED === '1';
}

/** What the "Sync Amazon" buttons queue: a command for the browser extension, not the sidecar. */
export const AMAZON_BUTTON_COMMAND = { type: 'SYNC_AMAZON_PAGES' } as const;
export const AMAZON_BUTTON_HINT =
  'Queued for your browser extension, which opens Your Orders and reads the pages. If nothing opens, the extension is not connected: open amazon.com/your-orders yourself and the extension will pick the pages up as you browse.';
