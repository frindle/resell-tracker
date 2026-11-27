// Resolve a deal link to its clean product URL: offline when the link already
// names its destination, else follow the redirect chain (8s cap).
import { cleanUrl, isHttpUrl, resolveLanded, resolveOffline } from '@/lib/linkClean';

export async function resolveDealLink(raw: string): Promise<string> {
  if (!isHttpUrl(raw)) throw new Error('Only http/https URLs allowed');
  const offline = resolveOffline(raw);
  if (offline) return offline;
  try {
    const res = await fetch(raw, {
      method: 'GET',
      redirect: 'follow',
      signal: AbortSignal.timeout(8000),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; link-resolver/1.0)' },
    });
    return resolveLanded(res.url);
  } catch {
    return cleanUrl(raw);
  }
}
