import { getSessionUserId } from '../auth';
import { booksEnabled } from './service.ts';

/** Run a books route body for a known user: 404 when the feature is off, 500 on a thrown error. */
export async function runWithBooks(userId: number, fn: (userId: number) => Promise<Response>, opts: { allowDisabled?: boolean } = {}): Promise<Response> {
  try {
    if (!opts.allowDisabled && !(await booksEnabled(userId))) return Response.json({ error: 'books are off' }, { status: 404 });
    return await fn(userId);
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

/** Run a books route body for the signed-in user; 401 when signed out, 404 when the feature is off. */
export async function withBooks(fn: (userId: number) => Promise<Response>, opts: { allowDisabled?: boolean } = {}): Promise<Response> {
  try {
    const userId = await getSessionUserId();
    if (userId == null) return Response.json({ error: 'sign in required' }, { status: 401 });
    return await runWithBooks(userId, fn, opts);
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
