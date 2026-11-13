import { NextRequest } from 'next/server';
import { withBooks } from '@/lib/books/api';
import { connectSimpleFin, disconnect, syncSimpleFin, EncryptionKeyMissingError } from '@/lib/books/bank/service';
import { SimpleFinError } from '@/lib/books/bank/simplefin';

/** Body { setupToken }. Claims the token, stores the Access URL encrypted, then runs the first sync. */
export async function POST(req: NextRequest) {
  return withBooks(async userId => {
    const body = await req.json().catch(() => ({}));
    if (typeof body.setupToken !== 'string' || !body.setupToken.trim()) return Response.json({ error: 'setupToken required' }, { status: 400 });
    try {
      await connectSimpleFin(userId, body.setupToken);
    } catch (e) {
      if (e instanceof EncryptionKeyMissingError) return Response.json({ error: e.message }, { status: 409 });
      if (e instanceof SimpleFinError) return Response.json({ error: e.message }, { status: e.status === 403 ? 403 : 400 });
      throw e;
    }
    try {
      const sum = await syncSimpleFin(userId);
      return Response.json({ ok: true, ...sum }, { status: 201 });
    } catch (e) {
      // Connected but the first sync failed: the connection is saved, the error shows in the UI.
      return Response.json({ ok: true, connected: true, syncError: e instanceof Error ? e.message : 'sync failed' }, { status: 201 });
    }
  });
}

export async function DELETE() {
  return withBooks(async userId => { await disconnect(userId); return Response.json({ ok: true }); });
}
