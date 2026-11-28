import { getSessionUserId } from '@/lib/auth';
import { cloudflareCreds } from '@/lib/emailCreds';
import { backfillRemittances } from '@/lib/remittanceRun';

export const dynamic = 'force-dynamic';

// Re-reads the group payment emails (BFMR, ...) in the order inbox and its 7-day archive and ties each payment to its orders by
// tracking number. Safe to run again: a payment id updates in place. Returns counts only.
export async function POST() {
  const userId = await getSessionUserId();
  if (userId == null) return Response.json({ error: 'Not signed in' }, { status: 401 });
  const cf = await cloudflareCreds();
  if (!cf) return Response.json({ error: 'Cloudflare order inbox not configured' }, { status: 400 });
  return Response.json(await backfillRemittances(cf));
}
