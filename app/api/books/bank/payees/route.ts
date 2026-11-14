import { withBooks } from '@/lib/books/api';
import { listPayees } from '@/lib/books/bank/service';

/** The learned payer names (ACH / direct deposit only) and the buyer each narrows to; shared ones narrow nothing. */
export async function GET() {
  return withBooks(async userId => Response.json({ payees: await listPayees(userId) }));
}
