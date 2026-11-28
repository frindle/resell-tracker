import type { Suggestion } from '@/lib/books/bank/acceptOptions';

export type Txn = {
  id: number; accountId: number; accountName: string; postedDate: string; amountCents: number; description: string; pending: boolean; source: string;
  matchStatus: string; mapped: boolean; depositable?: boolean;
  links: { id: number; kind: string; refId: number; amountCents: number; note: string | null; matchedBy: string }[];
  peers?: Record<number, { accountName: string; postedDate: string }>; // the other row of a transfer or a pair
  orders?: Record<number, { platform: string; orderNumber: string | null; orderDate: string; items: string | null; buyer: string | null; totalCents: number }>;
  amountChanged?: boolean; // the links no longer add up to the amount: it changed when the row posted
  suggestion: Suggestion | null;
};
export const isOpenTxn = (t: Pick<Txn, 'matchStatus'>) => t.matchStatus === 'unmatched' || t.matchStatus === 'suggested';
