// Resolve a deal link to its clean product URL: offline when the link already
// names its destination, else follow the redirect chain by hand (see
// lib/safeFetch.ts: public hosts only, max 5 hops, 8s cap).
import { cleanUrl, isHttpUrl, resolveLanded, resolveOffline } from '@/lib/linkClean';
import { fetchFinalUrl } from '@/lib/safeFetch';

export async function resolveDealLink(raw: string): Promise<string> {
  if (!isHttpUrl(raw)) throw new Error('Only http/https URLs allowed');
  const offline = resolveOffline(raw);
  if (offline) return offline;
  try {
    return resolveLanded(await fetchFinalUrl(raw));
  } catch {
    // A blocked or failed chain falls back to the offline scrub; a blocked host is never requested.
    return cleanUrl(raw);
  }
}
