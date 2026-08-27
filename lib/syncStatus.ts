/**
 * Reading the ExtensionCommand queue as a status feed.
 *
 * The queue is still the real transport for the Sync Amazon / Walmart / Costco
 * buttons: the app inserts a row, and whichever worker polls first (the
 * headless sidecar, or a browser extension if one is still installed) claims
 * it and moves it pending -> running -> done|failed. `result` is a free-form
 * string column written by more than one client, which is why nothing here
 * assumes it parses.
 *
 * Split out of components/SyncStatusIndicator.tsx so it can be tested: the
 * repo's test runner is Node's built-in one with type stripping, which does
 * not handle JSX.
 */

export type ExtCommand = {
  id: number;
  type: string;
  status: string;              // pending | running | done | failed
  result: string | null;
  claimedBy: string | null;
  createdAt: string;
  updatedAt: string;
};

const TYPE_LABELS: Record<string, string> = {
  SYNC_AMAZON: 'Amazon sync',
  SYNC_AMAZON_ORDER: 'Amazon order sync',
  SYNC_WALMART: 'Walmart sync',
  SYNC_COSTCO: 'Costco sync',
  SYNC_BIGSKY: 'BigSky sync',
  SCRAPE_CBM: 'Cashback rates',
};

export function commandLabel(type: string): string {
  return TYPE_LABELS[type] ?? type.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
}

export const isActiveCommand = (c: Pick<ExtCommand, 'status'>) => c.status === 'pending' || c.status === 'running';
export const isFinishedCommand = (c: Pick<ExtCommand, 'status'>) => c.status === 'done' || c.status === 'failed';

export const STATUS_WORD: Record<string, string> = {
  pending: 'queued',
  running: 'running',
  done: 'completed',
  failed: 'failed',
};

export function relativeTime(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

/**
 * One line describing how a command went. The sidecar writes
 * { platform, scraped, imported, updated, skipped, ... } on success and
 * { error, ... } on failure. Anything that doesn't parse is shown as-is
 * rather than dropped -- a status panel that silently hides the one message
 * explaining a failure is worse than no panel.
 */
export function summarizeResult(result: string | null): string | null {
  if (!result) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(result);
  } catch {
    return result.slice(0, 160);
  }
  // The PATCH route JSON.stringify()s whatever it is given. The sidecar hands
  // it an object, so one parse is enough -- but a caller that stringifies
  // first lands a JSON string inside a JSON string, and one parse leaves a
  // string that still needs unwrapping. Unwrap once rather than printing the
  // raw blob at the reader.
  if (typeof parsed === 'string') {
    const inner = parsed;
    try {
      parsed = JSON.parse(inner);
    } catch {
      return inner.slice(0, 160);
    }
  }
  if (parsed === null || typeof parsed !== 'object') return String(parsed).slice(0, 160);
  const r = parsed as Record<string, unknown>;
  if (typeof r.error === 'string' && r.error) return r.error.slice(0, 160);
  const num = (k: string) => (typeof r[k] === 'number' ? (r[k] as number) : null);
  const bits: string[] = [];
  const imported = num('imported');
  const updated = num('updated');
  const skipped = num('skipped');
  const scraped = num('scraped');
  if (imported !== null) bits.push(`${imported} new`);
  if (updated !== null) bits.push(`${updated} updated`);
  if (skipped !== null) bits.push(`${skipped} unchanged`);
  if (!bits.length && scraped !== null) bits.push(`${scraped} scraped`);
  const receipts = num('receiptsLinked');
  if (receipts) bits.push(`${receipts} receipts linked`);
  return bits.length ? bits.join(' · ') : null;
}

/**
 * What the corner indicator should show right now: everything still in
 * flight, plus anything that finished recently enough to still be worth
 * seeing, newest first. Returning [] is the normal state -- the panel is
 * meant to be invisible when there is nothing true to say.
 */
export function visibleCommands(
  commands: ExtCommand[],
  opts: { now: number; dismissed?: ReadonlySet<number>; keepFinishedMs: number; limit?: number },
): ExtCommand[] {
  const dismissed = opts.dismissed ?? new Set<number>();
  const active = commands.filter(isActiveCommand);
  const recent = commands.filter(
    c => isFinishedCommand(c)
      && !dismissed.has(c.id)
      && opts.now - new Date(c.updatedAt).getTime() < opts.keepFinishedMs,
  );
  return [...active, ...recent]
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, opts.limit ?? 4);
}
