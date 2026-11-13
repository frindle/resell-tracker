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

  // Rolling 7-day retention prune for the outbound API call log (see
  // lib/apiCallLog.ts) -- built after a real 2026-08-21 incident where
  // reconstructing what actually got submitted to BFMR, when, wasn't
  // possible from UI state alone.
  const { startApiCallLogRetention } = await import('./lib/apiCallLog');
  startApiCallLogRetention();

  // CardCenter waitlist — hourly, OPT-IN per user (Setting
  // `cc_waitlist_auto_enabled`). It sells real gift cards unattended, so with
  // nobody opted in the tick is a single cheap query and nothing else.
  const { startWaitlistRunner } = await import('./lib/waitlistRunner');
  startWaitlistRunner();

  // CardCenter photo backfill: hourly, sends photos for cards submitted before
  // photo sending existed. Gated per user by Setting `cc_send_images`.
  const { startImageBackfill } = await import('./lib/cardcenterImagesBackfill');
  startImageBackfill();

  // Double-entry books: reconciler every 10 min, Darkbloom tally daily at 06:00 LA.
  // Both do nothing unless Setting `accounting.enabled` is on for a user.
  const { startBooks } = await import('./lib/books/scheduler');
  startBooks();

  // Photo OCR queue is in memory; pick up photos a restart left half-read.
  // Delayed so the OCR service (same container) has loaded its models.
  const { resumePendingPhotoOcr } = await import('./lib/photoOcrRun');
  setTimeout(() => { resumePendingPhotoOcr().catch(err => console.error('[photo-ocr] resume failed:', err)); }, 60_000);
}
