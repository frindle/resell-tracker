import type { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { canCancel } from '@/lib/extensionCommandActions';

// POST /api/extension/commands/:id/cancel -- the Sync Status popup's "Cancel".
// Session-cookie gated like the DELETE beside it, but unlike DELETE it only
// removes a row nobody has claimed yet.
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const cmd = await prisma.extensionCommand.findUnique({ where: { id: parseInt(id) } });
    if (!cmd) return Response.json({ error: 'command not found' }, { status: 404 });
    if (!canCancel(cmd.status)) return Response.json({ error: `cannot cancel a ${cmd.status} command` }, { status: 409 });
    // updateMany with the status guard: a worker claiming it between the read and now wins.
    const res = await prisma.extensionCommand.deleteMany({ where: { id: cmd.id, status: 'pending' } });
    if (res.count === 0) return Response.json({ error: 'command was just claimed' }, { status: 409 });
    return Response.json({ id: cmd.id, action: 'cancelled' });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
