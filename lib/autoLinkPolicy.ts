// Rules for how automatic BFMR linking interacts with the user's own choices.

/** Deleting a reservation's LAST link means "this isn't mine": stop auto-link re-adding it. */
export function dismissOnUnlink(remainingLinks: number): boolean {
  return remainingLinks === 0;
}

/** Background repricing (respectLock) leaves locked orders alone; user actions always reprice. */
export function lockBlocksRecalc(locked: boolean | null | undefined, respectLock: boolean | undefined): boolean {
  return !!locked && !!respectLock;
}
