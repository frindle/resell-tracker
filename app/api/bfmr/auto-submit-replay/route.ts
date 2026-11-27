import { getSessionUserId } from '@/lib/auth';
import { evaluatePackages } from '@/lib/bfmrDryRun';
import { orderNumbersAgree, normTracking } from '@/lib/bfmrLinkGuard';
import { replayVerdict, type ReplayRow } from '@/lib/bfmrAutoSubmitPlan';

export const dynamic = 'force-dynamic';

// READ-ONLY replay of the package matcher against history. For every stored
// package it shows the current decision (judged as if that package's own
// recorded submission did not exist), the rows it would send, and the
// BfmrSubmittedShipment rows already recorded for the order's reservations
// (what was submitted by hand), with a per-order agree/disagree verdict.
// Reads the local database only; it talks to nothing external.
export async function GET() {
  const userId = await getSessionUserId();
  if (userId == null) return Response.json({ error: 'unauthorized' }, { status: 401 });
  const ev = await evaluatePackages(userId, undefined, { excludeOwnSubmission: true });
  if (!ev) return Response.json({ orders: [], summary: { agree: 0, disagree: 0, no_data: 0 } });

  const byOrder = new Map<number, number[]>();
  ev.packages.forEach((p, i) => byOrder.set(p.orderId, [...(byOrder.get(p.orderId) ?? []), i]));

  const orders = [...byOrder].map(([orderId, idxs]) => {
    const first = ev.packages[idxs[0]];
    const trackings = new Set(idxs.map(i => normTracking(ev.packages[i].trackingNumber)));
    const packages = idxs.map(i => {
      const d = ev.decisions[i];
      return {
        trackingNumber: d.trackingNumber,
        decision: d.decision,
        reason: d.decision === 'manual' ? d.reason : null,
        message: d.message,
        wouldSend: d.allocations.map(a => ({ reservationId: a.reservationId, qty: a.qty, trackingNumber: d.trackingNumber })),
        caveats: d.caveats,
      };
    });
    const would: ReplayRow[] = packages.flatMap(p => p.wouldSend);
    // Recorded submissions on this order's reservations, for this order's packages.
    const mine = ev.lines.filter(l => l.links.some(k => k.orderId === orderId) || orderNumbersAgree(l.bfmrOrderId, first.orderNumber));
    const recorded: ReplayRow[] = mine.flatMap(l => l.submitted
      .filter(s => trackings.has(normTracking(s.trackingNumber)))
      .map(s => ({ reservationId: l.id, qty: s.qty, trackingNumber: s.trackingNumber })));
    return { orderId, orderNumber: first.orderNumber, verdict: replayVerdict(would, recorded), packages, recorded };
  });

  const summary = { agree: 0, disagree: 0, no_data: 0 };
  for (const o of orders) summary[o.verdict]++;
  return Response.json({ orders, summary });
}
