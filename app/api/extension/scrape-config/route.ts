import { scrapeConfigResponse } from '@/lib/scrapeConfig';
import { loadedScrapeConfig } from '@/lib/scrapeConfigLoaded';

// The extension's remote scrape config (selectors, labels, regex sources, URL
// patterns, timeouts: data only). Same extension-secret guard as the commands
// poll. ETag = version + content hash; If-None-Match gets a 304. An invalid
// file is logged at load and answered with a 500, so the extension keeps its cache.
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  return scrapeConfigResponse(req, loadedScrapeConfig);
}
