// Retries the pushes to bloom-ledger every 10 minutes (an order waiting for item details, a missing key, a failed void).
// A no-op without BLOOM_LEDGER_URL. Started from instrumentation.ts; gated so only the primary instance runs it.
import { gated } from './primaryFlag.ts';
import { retryAll } from './darkbloomPurchaseService';

let started = false;

export function startDarkbloomPush() {
  if (started) return;
  started = true;
  const tick = gated('darkbloom-push', async () => {
    if (!process.env.BLOOM_LEDGER_URL) return;
    await retryAll().catch(e => console.error('[darkbloom] retry:', String(e).slice(0, 160)));
  });
  setTimeout(tick, 5 * 60 * 1000);
  setInterval(tick, 10 * 60 * 1000);
}
