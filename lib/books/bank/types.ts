export type BankTxnIn = {
  providerTxnId: string;
  postedDate: string; // YYYY-MM-DD
  transactedDate: string | null;
  amountCents: number; // signed from the account holder's view
  description: string;
  payee: string | null;
  memo: string | null;
  pending: boolean;
};

export type BankAcctIn = {
  providerAccountId: string;
  name: string;
  orgName: string | null;
  currency: string;
  kind: 'bank' | 'credit' | 'investment' | 'other';
  last4: string | null;
  balanceCents: number | null;
  balanceDate: string | null;
  transactions: BankTxnIn[];
};

export type FeedError = { code: string; msg: string; connId: string | null; accountId: string | null };
