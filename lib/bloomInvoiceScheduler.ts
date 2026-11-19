// Daily Bloom invoice pull, started from instrumentation.ts: the first tick at or after 06:30 Los Angeles time.
// On the 1st that picks up the month that just ended (once the ledger calls it final); on other days it finds nothing
// new. A no-op when BLOOM_LEDGER_URL is unset or nobody has Bloom invoices yet.
import { bloomSyncAllUsers } from './bloomInvoiceService';

let started = false;

export function startBloomInvoices() {
  if (started) return;
  started = true;
  let lastDay = '';
  const tick = () => {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
    const g = (t: string) => parts.find(p => p.type === t)!.value;
    const day = `${g('year')}-${g('month')}-${g('day')}`;
    if ((Number(g('hour')) > 6 || (Number(g('hour')) === 6 && Number(g('minute')) >= 30)) && day !== lastDay) {
      lastDay = day;
      bloomSyncAllUsers().catch(e => console.error('[bloom] invoice sync:', e));
    }
  };
  setTimeout(tick, 4 * 60 * 1000);
  setInterval(tick, 10 * 60 * 1000);
}
