// Books background jobs, started from instrumentation.ts. Both are cheap no-ops
// unless a user has turned `accounting.enabled` on (and, for the tally, BLOOM_LEDGER_URL is set).
import { reconcileAllUsers, tallyAllUsers } from './service.ts';
import { syncAllBankUsers } from './bank/service.ts';

let started = false;

export function startBooks() {
  if (started) return;
  started = true;
  // Reconciler: every 10 minutes (first run 2 minutes after boot).
  setTimeout(() => { reconcileAllUsers().catch(e => console.error('[books] reconcile:', e)); }, 2 * 60 * 1000);
  setInterval(() => { reconcileAllUsers().catch(e => console.error('[books] reconcile:', e)); }, 10 * 60 * 1000);

  // Darkbloom tally: once a day, the first tick at or after 06:00 Los Angeles time.
  // Bank feed (SimpleFIN): once a day, first tick at or after 07:00 LA (one request a day against a ~24/day quota;
  // a no-op for users with the books off or no connection).
  let lastTallyDay = '';
  let lastBankDay = '';
  const tick = () => {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
    const g = (t: string) => parts.find(p => p.type === t)!.value;
    const day = `${g('year')}-${g('month')}-${g('day')}`;
    if (Number(g('hour')) >= 6 && day !== lastTallyDay) {
      lastTallyDay = day;
      tallyAllUsers().catch(e => console.error('[books] tally:', e));
    }
    if (Number(g('hour')) >= 7 && day !== lastBankDay) {
      lastBankDay = day;
      syncAllBankUsers().catch(e => console.error('[books] bank sync:', e instanceof Error ? e.message : 'error'));
    }
  };
  setTimeout(tick, 3 * 60 * 1000);
  setInterval(tick, 10 * 60 * 1000);
}
