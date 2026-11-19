import { getSessionUserId } from '@/lib/auth';
import { runBloomSync } from '@/lib/bloomInvoiceService';

// On demand: pull the ledger's final months now. Idempotent, so pressing it twice changes nothing.
export async function POST() {
  try {
    const userId = await getSessionUserId();
    if (userId == null) return Response.json({ error: 'sign in required' }, { status: 401 });
    const r = await runBloomSync(userId);
    if ('notOwner' in r) return Response.json({ error: "Bloom invoices belong to the tracker owner's account" }, { status: 403 });
    if ('disabled' in r) return Response.json({ error: 'BLOOM_LEDGER_URL is not set' }, { status: 409 });
    return Response.json(r);
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
