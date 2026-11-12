export type AccountType = 'asset' | 'liability' | 'equity' | 'income' | 'contra_income' | 'cogs' | 'expense';
export type Business = 'resell' | 'darkbloom' | 'shared';
export type EntrySource = 'order' | 'cost' | 'darkbloom' | 'opening' | 'manual' | 'reversal';

/** A systemKey ("inventory_goods", "card:12", "buyer:5", "loan:3") or a LedgerAccount id. */
export type AcctRef = string | number;

export type LineInput = {
  account: AcctRef;
  amountCents: number; // debit +, credit -
  orderId?: number | null;
  machineId?: string | null;
  memo?: string | null;
  business?: Business | null;
};

export type EntryInput = {
  date: string;
  memo: string;
  source: EntrySource;
  sourceKey: string;
  contentHash: string;
  lines: LineInput[];
  reversesId?: number | null;
};

export type AccountRow = {
  id: number;
  userId: number;
  code: string;
  name: string;
  type: AccountType;
  business: Business;
  scheduleCLine: string | null;
  systemKey: string | null;
  creditCardId: number | null;
  buyerId: number | null;
  loanId: number | null;
  active: boolean;
};

export type PostedLine = {
  id: number;
  entryId: number;
  accountId: number;
  amountCents: number;
  orderId: number | null;
  machineId: string | null;
  memo: string | null;
  business: string | null;
};

export type PostedEntry = {
  id: number;
  userId: number;
  date: string;
  memo: string;
  source: string;
  sourceKey: string;
  contentHash: string;
  reversesId: number | null;
  reversedAt: Date | null;
  lines: PostedLine[];
};

export type StoredLine = {
  accountId: number;
  amountCents: number;
  orderId: number | null;
  machineId: string | null;
  memo: string | null;
  business: string | null;
};

/** One journal line joined with its entry and account, for reports. Reversal entries are included, so live balances net out. */
export type LedgerLineRow = {
  entryId: number;
  date: string;
  entryMemo: string;
  source: string;
  sourceKey: string;
  accountId: number;
  code: string;
  accountName: string;
  type: AccountType;
  systemKey: string | null;
  business: Business; // line business, else the account's
  amountCents: number;
  orderId: number | null;
  machineId: string | null;
  memo: string | null;
};

/** Everything the books layer needs from storage. Prisma and in-memory implementations. */
export interface BooksStore {
  transaction<T>(fn: (tx: BooksStore) => Promise<T>): Promise<T>;
  lockedMonths(userId: number): Promise<Set<string>>;
  /** Find (creating per-card/buyer/loan accounts on demand) the account for a ref. Throws when unknown. */
  resolveAccount(userId: number, ref: AcctRef): Promise<AccountRow>;
  insertEntry(
    userId: number,
    e: { date: string; memo: string; source: string; sourceKey: string; contentHash: string; reversesId: number | null },
    lines: StoredLine[],
  ): Promise<number>;
  /** Mark an entry reversed only if it is not already. Returns false when it was (someone else reversed it first). */
  markReversed(entryId: number, at: Date): Promise<boolean>;
  /** Entries (with lines) not yet reversed and not themselves reversals, whose sourceKey starts with prefix. */
  livePosted(userId: number, sourceKeyPrefix: string): Promise<PostedEntry[]>;
  /** Every line (reversals included) with date in [from, to] (inclusive, either optional), or for the given orders. */
  ledgerLines(userId: number, opts?: { from?: string; to?: string; orderIds?: number[] }): Promise<LedgerLineRow[]>;
  /** All accounts for the user. */
  listAccounts(userId: number): Promise<AccountRow[]>;
  /** orderId -> event -> 'YYYY-MM-DD' for the given orders. */
  eventDates(orderIds: number[]): Promise<Map<number, Map<string, string>>>;
  /** Insert the stamp if absent; an existing stamp is never changed. */
  stampEvent(orderId: number, event: string, date: string, inferred?: boolean): Promise<void>;
}
