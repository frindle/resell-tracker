import type { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { retryDedupeWhere } from '@/lib/extensionCommandDedupe';
import { planRetry } from '@/lib/extensionCommandActions';
import { kickSidecarPoll } from '@/lib/sidecarKick';

// POST /api/extension/commands/:id/retry -- the Sync Status popup's
// "Retry on sidecar". Like the DELETE beside it this is a web-UI action: it is
// gated by proxy.ts's session cookie and takes no extension secret.
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const cmd = await prisma.extensionCommand.findUnique({ where: { id: parseInt(id) } });
    if (!cmd) return Response.json({ error: 'command not found' }, { status: 404 });

    const pending = await prisma.extensionCommand.findMany({ where: { status: 'pending' } });
    const plan = planRetry(cmd, pending);

    switch (plan.kind) {
      case 'unsupported':
        return Response.json({ error: 'the sidecar does not run this command type' }, { status: 409 });
      case 'busy':
        return Response.json({ error: 'command is already running' }, { status: 409 });
      case 'already':
        kickSidecarPoll();
        return Response.json({ id: plan.id, action: 'already-queued' });
      case 'merge': {
        // Only a row nobody has claimed may be dropped.
        const del = await prisma.extensionCommand.deleteMany({ where: { id: plan.deleteId, status: 'pending' } });
        if (del.count === 0) return Response.json({ error: 'command is no longer pending' }, { status: 409 });
        kickSidecarPoll();
        return Response.json({ id: plan.keepId, action: 'already-queued' });
      }
      case 'retarget': {
        const upd = await prisma.extensionCommand.updateMany({
          where: { id: plan.id, status: 'pending' },
          data: { type: plan.type, targetBrowser: plan.targetBrowser, claimedBy: null },
        });
        if (upd.count === 0) return Response.json({ error: 'command is no longer pending' }, { status: 409 });
        kickSidecarPoll();
        return Response.json({ id: plan.id, action: 'retargeted' });
      }
      case 'create': {
        // Like POST /api/extension/commands, a pending or running copy (e.g.
        // auto-sync, or another tab's click) is reused, but a per-order
        // command only matches a row for the same orders (equal payload).
        const existing = await prisma.extensionCommand.findFirst({
          where: retryDedupeWhere(plan.type, plan.targetBrowser, plan.payload),
        });
        if (existing) {
          kickSidecarPoll();
          return Response.json({ id: existing.id, action: 'already-queued' });
        }
        const row = await prisma.extensionCommand.create({
          data: { type: plan.type, payload: plan.payload, targetBrowser: plan.targetBrowser },
        });
        kickSidecarPoll();
        return Response.json({ id: row.id, action: 'queued' }, { status: 201 });
      }
    }
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
