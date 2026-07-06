export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  const { runBgReceiptSync } = await import('./lib/bgSync');
  const { startWatcher } = await import('./lib/bfmrWatcher');

  // Run once on startup, then every 6 hours
  runBgReceiptSync();
  setInterval(runBgReceiptSync, 6 * 60 * 60 * 1000);

  // BFMR deal watcher — polls every 2 minutes
  startWatcher();

  // Delivery-deadline Pushover digest — evaluates every 6h, sends at most
  // one digest per user per day.
  const { startDeadlineReminders } = await import('./lib/deadlineReminders');
  startDeadlineReminders();
}
