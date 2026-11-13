import { NextRequest } from 'next/server';
import { withBooks } from '@/lib/books/api';
import { updateRule, deleteRule, HttpError } from '@/lib/books/bank/service';

/** Any rule field; the page uses { enabled } to switch a rule on or off. */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withBooks(async userId => {
    const { id } = await params;
    const body = await req.json().catch(() => ({}));
    try {
      return Response.json(await updateRule(userId, Number(id), body));
    } catch (e) {
      if (e instanceof HttpError) return Response.json({ error: e.message }, { status: e.status });
      throw e;
    }
  });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withBooks(async userId => {
    const { id } = await params;
    try {
      return Response.json(await deleteRule(userId, Number(id)));
    } catch (e) {
      if (e instanceof HttpError) return Response.json({ error: e.message }, { status: e.status });
      throw e;
    }
  });
}
