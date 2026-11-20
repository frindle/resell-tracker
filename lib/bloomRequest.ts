import { headers } from 'next/headers';
import { bloomAccess } from './bloomAccess';
import { getOwnerUserId } from './owner';

/** The user the Bloom routes act as: the tracker owner, once the request passed the LAN or Cloudflare Access check
 *  (no session cookie involved). A reason string when the request is refused. */
export async function bloomUser(): Promise<{ userId: number } | { status: number; error: string }> {
  const a = await bloomAccess(await headers());
  if (!a.ok) return { status: 403, error: `Bloom is reachable on the LAN, or through Cloudflare Access (${a.reason})` };
  const userId = await getOwnerUserId();
  if (userId == null) return { status: 404, error: 'no tracker owner yet' };
  return { userId };
}
