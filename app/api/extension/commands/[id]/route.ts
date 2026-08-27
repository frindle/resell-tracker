import type { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { verifyExtensionSecret } from '@/lib/extensionAuth';

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
  const command = await prisma.extensionCommand.update({
    where: { id: parseInt(id) },
    data: {
      status,
      result: result != null ? JSON.stringify(result) : null,
      ...(claimedBy ? { claimedBy } : {}),
    },
  });
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
