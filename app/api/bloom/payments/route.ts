import { bloomUser } from '@/lib/bloomRequest';
import { addBloomRequest, loadPaymentRows } from '@/lib/bloomPaymentService';

// Read-only view of the Bloom payment record, for tracking: per invoice month, what was due once the invoice was final,
// when the payout was requested, when the matching Darkbloom deposit landed, and whether an unmatched request is flagged.
export async function GET() {
  try {
    const who = await bloomUser();
    if ('error' in who) return Response.json({ error: who.error }, { status: who.status });
    return Response.json({ months: await loadPaymentRows(who.userId) });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}

// A hand-entered request, for when the ledger's balance snapshots missed it. Records only; it moves no money.
export async function POST(req: Request) {
  try {
    const who = await bloomUser();
    if ('error' in who) return Response.json({ error: who.error }, { status: who.status });
    const b = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    const dollars = typeof b?.requestedDollars === 'number' ? Math.round(b.requestedDollars * 100) : NaN;
    const r = await addBloomRequest(who.userId, {
      month: String(b?.month ?? ''), requestedAt: String(b?.requestedAt ?? ''),
      requestedCents: typeof b?.requestedCents === 'number' ? b.requestedCents : dollars,
    });
    if ('error' in r) return Response.json({ error: r.error }, { status: r.status });
    return Response.json({ request: r.ok });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
