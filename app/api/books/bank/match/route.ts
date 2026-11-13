import { withBooks } from '@/lib/books/api';
import { runMatching } from '@/lib/books/bank/service';

/** Re-run the two matching rules over open transactions. */
export async function POST() {
  return withBooks(async userId => Response.json(await runMatching(userId)));
}
