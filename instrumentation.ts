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

  // BigSky session health — flags an expired/dead login (Pushover +
  // /api-errors + a badge in Settings) so the user re-logins before a
  // tracking submit silently fails.
  const { startBigSkyHealthCheck } = await import('./lib/bigskyHealth');
  startBigSkyHealthCheck();

  // Auto-sync CC payments + BFMR every 6h (10 min after boot), with a
  // "Payment received" Pushover when a sync flips orders to paid.
  const { startAutoSync } = await import('./lib/autoSync');
  startAutoSync();

  // Nightly SQLite snapshot to /data/backups (VACUUM INTO, keep 14).
  const { startDbBackup } = await import('./lib/dbBackup');
  startDbBackup();
}
