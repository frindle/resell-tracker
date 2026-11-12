import { withBooks } from '@/lib/books/api';
import { runReconcile } from '@/lib/books/service';

export async function POST() {
  return withBooks(async userId => Response.json(await runReconcile(userId)));
}
