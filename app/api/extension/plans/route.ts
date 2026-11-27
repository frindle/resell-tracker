import { plansResponse } from '@/lib/stepPlan';
import { loadedPlans } from '@/lib/stepPlanLoaded';

// The extension's step plans (config/plans.json, exact text) and the detached Ed25519
// signature (config/plans.json.sig, null when absent). Same extension-secret guard as the
// scrape config. ETag = plan version + content hash + sig; If-None-Match gets a 304. An invalid
// file is logged at load and answered with a 500, so the extension keeps its cache.
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  return plansResponse(req, loadedPlans);
}
