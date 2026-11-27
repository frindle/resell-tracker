import type { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { verifyExtensionSecret } from '@/lib/extensionAuth';
import { TRACK_AMAZON } from '@/lib/amazonTracking';
import { VISIT_AMAZON, pauseAutoVisits, settleAutoVisits } from '@/lib/amazonVisitQueue';
import type { Stage } from '@/lib/amazonVisitPlan';
import { egiftCommandEnded } from '@/lib/egiftShadowDb';
import { reportTrackFailure } from '@/lib/amazonTrackingQueue';

// PATCH is exclusively how a poller (sidecar or a real browser extension)
// reports a command's status back -- see the matching comment in
// ../route.ts's GET for why proxy.ts's own secret gate can't be relied on
// alone here. Nothing else in this repo calls this endpoint.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
  if (!verifyExtensionSecret(req)) {
    return Response.json({ error: 'extension secret missing or invalid' }, { status: 401 });
  }
  const { id } = await params;
  const { status, result } = await req.json() as { status: string; result?: unknown };

  const valid = ['running', 'done', 'failed'];
  if (!valid.includes(status)) return new Response(`invalid status: ${status}`, { status: 400 });

  const claimedBy = req.headers.get('X-Extension-Browser');
  // A report sent twice must not count a run's unread orders twice.
  const before = await prisma.extensionCommand.findUnique({ where: { id: parseInt(id) }, select: { status: true } });
  const alreadyEnded = before?.status === 'done' || before?.status === 'failed';
  const command = await prisma.extensionCommand.update({
    where: { id: parseInt(id) },
    data: {
      status,
      result: result != null ? JSON.stringify(result) : null,
      ...(claimedBy ? { claimedBy } : {}),
    },
  });
  // eGift shadow mode: a finished real scrape queues its one dry run; a finished dry run logs the comparison.
  if (command.type === 'SCRAPE_EGIFT' && !alreadyEnded && (status === 'done' || status === 'failed')) {
    await egiftCommandEnded({ type: command.type, payload: command.payload, status, result: command.result });
  }
  // Tell the user when the browser extension gives up on a tracking lookup.
  if (command.type === TRACK_AMAZON && status === 'failed' && claimedBy) {
    await reportTrackFailure(command.payload, result).catch(e => console.error('[amazon-tracking] failure report failed:', String(e).slice(0, 160)));
  }
  // A block page stops the automatic visits until the next Sync click.
  if (command.type === VISIT_AMAZON && status === 'failed' && (result as { blocked?: boolean } | null)?.blocked) {
    let uid = 0;
    try { uid = Number((JSON.parse(command.payload ?? '{}') as { userId?: unknown }).userId); } catch { /* none */ }
    if (uid > 0) await pauseAutoVisits(uid).catch(e => console.error('[amazon-visits] pause failed:', String(e).slice(0, 160)));
  }
  // An automatic run ended: orders whose pages were never read go back in line.
  if (command.type === VISIT_AMAZON && !alreadyEnded && (status === 'done' || status === 'failed')) {
    try {
      const p = JSON.parse(command.payload ?? '{}') as { userId?: unknown; visits?: { orderNumber?: unknown; stages?: unknown }[] };
      const uid = Number(p.userId);
      const visits = (Array.isArray(p.visits) ? p.visits : [])
        .map(v => ({
          orderNumber: String(v?.orderNumber ?? ''),
          stages: (Array.isArray(v?.stages) ? v.stages : []).filter((s): s is Stage => s === 'detail' || s === 'track'),
        }))
        .filter(v => v.orderNumber);
      const r = (result ?? {}) as { blocked?: unknown; notStarted?: unknown; pages?: unknown };
      if (uid > 0 && visits.length) {
        await settleAutoVisits(uid, visits, command.createdAt, {
          // Not the orders' fault: a block page, or another run was already going.
          refund: r.blocked === true || r.notStarted === true,
          pages: typeof r.pages === 'number' && Number.isFinite(r.pages) ? r.pages : undefined,
        });
      }
    } catch (e) {
      console.error('[amazon-visits] settle failed:', String(e).slice(0, 160));
    }
  }
  return Response.json(command);
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
  const { id } = await params;
  await prisma.extensionCommand.delete({ where: { id: parseInt(id) } });
  return new Response(null, { status: 204 });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
