import { bloomUser } from '@/lib/bloomRequest';
import { runBloomAndBooks } from '@/lib/bloomInvoiceService';

// On demand: pull the ledger's final months now. Idempotent, so pressing it twice changes nothing.
export async function POST() {
  try {
    const who = await bloomUser();
    if ('error' in who) return Response.json({ error: who.error }, { status: who.status });
    const userId = who.userId;
    const r = await runBloomAndBooks(userId);
    if ('notOwner' in r) return Response.json({ error: "Bloom invoices belong to the tracker owner's account" }, { status: 403 });
    if ('disabled' in r) return Response.json({ error: 'BLOOM_LEDGER_URL is not set' }, { status: 409 });
    return Response.json(r);
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
