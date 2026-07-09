import { readdir, unlink, mkdir, stat } from 'fs/promises';
import { join, dirname } from 'path';
import { prisma } from './db';

// Nightly SQLite backup. The whole business lives in one .db file on the
// cache pool — this snapshots it safely while the app runs (VACUUM INTO
// takes a consistent copy without locking writers) and rotates old copies.
//
// Destination: $BACKUP_DIR, or <db directory>/backups (on the same /data
// volume as the DB, so it survives container rebuilds).

const KEEP = 14;

function dbPathFromEnv(): string | null {
  const url = process.env.DATABASE_URL ?? '';
  const m = url.match(/^file:(.+)$/);
  return m ? m[1] : null;
}

function localDateStr(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export async function runDbBackup(): Promise<void> {
  const dbPath = dbPathFromEnv();
  if (!dbPath) {
    console.warn('[db-backup] DATABASE_URL is not a file: URL — skipping');
    return;
  }
  const dir = process.env.BACKUP_DIR ?? join(dirname(dbPath), 'backups');
  const dest = join(dir, `resell-${localDateStr()}.db`);
  try {
    await mkdir(dir, { recursive: true });
    // Already have today's backup (e.g. container restarted) — skip.
    try { await stat(dest); return; } catch { /* not there yet — proceed */ }
    await prisma.$executeRawUnsafe(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
    const size = (await stat(dest)).size;
    console.log(`[db-backup] wrote ${dest} (${(size / 1024 / 1024).toFixed(1)} MB)`);

    // Rotate: keep the newest KEEP snapshots.
    const files = (await readdir(dir))
      .filter(f => /^resell-\d{4}-\d{2}-\d{2}\.db$/.test(f))
      .sort()
      .reverse();
    for (const f of files.slice(KEEP)) {
      await unlink(join(dir, f)).catch(() => {});
      console.log(`[db-backup] rotated out ${f}`);
    }
  } catch (e) {
    console.error('[db-backup] failed:', e);
  }
}

export function startDbBackup(): void {
  // First run shortly after boot (covers "container was down at 3:30am"),
  // then every 24h. The same-day skip above makes restarts idempotent.
  setTimeout(runDbBackup, 5 * 60 * 1000);
  setInterval(runDbBackup, 24 * 60 * 60 * 1000);
}
