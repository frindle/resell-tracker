// The one place that knows what an Order.deliveryDeadline MEANS.
//
// Buying groups do not agree on what their deadline date is a deadline
// *for*:
//   - BuyingGroup.com (BG) sets a date the order must be DELIVERED by.
//   - BFMR sets a date TRACKING must be UPLOADED by.
//
// Those are different obligations with different remedies — an order that
// arrives late fails a BG deadline, while an order whose tracking is
// entered late fails a BFMR one even if the package itself is early. The
// schema used to store only the date, so every reader picked one meaning
// (delivery) and applied it to both. Order.deadlineKind now records the
// meaning on the row, and everything user-facing routes its copy through
// the labels below rather than re-deriving intent from the group.

export const DEADLINE_KINDS = ['DELIVER_BY', 'TRACKING_BY'] as const;
export type DeadlineKind = (typeof DEADLINE_KINDS)[number];

export const DEFAULT_DEADLINE_KIND: DeadlineKind = 'DELIVER_BY';

export function isDeadlineKind(v: unknown): v is DeadlineKind {
  return typeof v === 'string' && (DEADLINE_KINDS as readonly string[]).includes(v);
}

// Tolerant read for values coming off the DB or an API body. Unknown or
// missing values fall back to DELIVER_BY, which is what the column meant
// before the discriminator existed.
export function toDeadlineKind(v: unknown): DeadlineKind {
  return isDeadlineKind(v) ? v : DEFAULT_DEADLINE_KIND;
}

type Copy = {
  /** Badge prefix on the order card, e.g. "Deliver By Mar 4". */
  badgePrefix: string;
  /** Short noun phrase for the badge tooltip / form help. */
  noun: string;
  /** Sentence describing the obligation. */
  description: string;
  /** Verb phrase used in the Pushover digest, e.g. "delivery due Mar 4". */
  dueLabel: string;
  /** What is overdue, for the digest's OVERDUE lines. */
  overdueLabel: string;
  /** Which group this convention comes from, for form help text. */
  groupHint: string;
};

const COPY: Record<DeadlineKind, Copy> = {
  DELIVER_BY: {
    badgePrefix: 'Deliver By',
    noun: 'delivery deadline',
    description: 'The order must be delivered by this date.',
    dueLabel: 'delivery due',
    overdueLabel: 'delivery overdue',
    groupHint: 'BuyingGroup.com',
  },
  TRACKING_BY: {
    badgePrefix: 'Tracking By',
    noun: 'tracking-upload deadline',
    description: 'Tracking must be uploaded by this date.',
    dueLabel: 'tracking due',
    overdueLabel: 'tracking upload overdue',
    groupHint: 'BFMR',
  },
};

export function deadlineCopy(kind: unknown): Copy {
  return COPY[toDeadlineKind(kind)];
}

export const DEADLINE_KIND_OPTIONS: { value: DeadlineKind; label: string }[] = DEADLINE_KINDS.map(k => ({
  value: k,
  label: `${COPY[k].badgePrefix} — ${COPY[k].description} (${COPY[k].groupHint})`,
}));
