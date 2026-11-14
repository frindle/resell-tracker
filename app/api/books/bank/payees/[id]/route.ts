import { NextRequest } from 'next/server';
import { withBooks } from '@/lib/books/api';
import { deletePayee, HttpError } from '@/lib/books/bank/service';

/** Forget one learned payer name. */
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withBooks(async userId => {
    const { id } = await params;
    try {
      return Response.json(await deletePayee(userId, Number(id)));
    } catch (e) {
      if (e instanceof HttpError) return Response.json({ error: e.message }, { status: e.status });
      throw e;
    }
  });
}
