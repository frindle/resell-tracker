import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
  const { id } = await params;
  const { status, result } = await req.json() as { status: string; result?: unknown };

  const valid = ['running', 'done', 'failed'];
  if (!valid.includes(status)) return new Response(`invalid status: ${status}`, { status: 400 });

  const command = await prisma.extensionCommand.update({
    where: { id: parseInt(id) },
    data: { status, result: result != null ? JSON.stringify(result) : null },
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
