import { bloomUser } from '@/lib/bloomRequest';
import { addBloomRequest, loadPaymentView } from '@/lib/bloomPaymentService';

// Read-only view of the Bloom payment record, for tracking: { months, requests }. Per invoice month: payout, allocated (Darkbloom
// deposits applied oldest first), due and status; plus every payout request (sent, pending, flagged or refunded).
export async function GET() {
  try {
    const who = await bloomUser();
    if ('error' in who) return Response.json({ error: who.error }, { status: who.status });
    return Response.json(await loadPaymentView(who.userId));
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
      requestedAt: String(b?.requestedAt ?? ''),
      requestedCents: typeof b?.requestedCents === 'number' ? b.requestedCents : dollars,
    });
    if ('error' in r) return Response.json({ error: r.error }, { status: r.status });
    return Response.json({ request: r.ok });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
