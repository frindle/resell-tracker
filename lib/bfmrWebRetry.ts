/**
 * Pure retry-once-on-401 policy for BFMR's web-app tracker fetch. Kept free of
 * DB / alias imports so it is testable with node --test (bfmrWeb.ts is not).
 */

export const BFMR_WEB_SESSION_EXPIRED_MESSAGE = 'BFMR web session expired - re-login needed';

export class BfmrWebSessionExpiredError extends Error {
  constructor() {
    super(BFMR_WEB_SESSION_EXPIRED_MESSAGE);
    this.name = 'BfmrWebSessionExpiredError';
  }
}

export type TrackerReloginDeps<S, T> = {
  getSession: () => Promise<S>;
  dropSession: () => Promise<void>;
  fetchRows: (session: S) => Promise<T>;
};

export function isTracker401(err: unknown): boolean {
  throw new Error('not implemented: isTracker401');
}

export async function fetchTrackerWithRelogin<S, T>(deps: TrackerReloginDeps<S, T>): Promise<T> {
  throw new Error('not implemented: fetchTrackerWithRelogin');
}
