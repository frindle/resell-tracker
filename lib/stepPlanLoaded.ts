// The checked-in plans, read once at startup as exact text (the signature covers the exact bytes,
// so this is not a JSON import) plus the optional detached signature. A deploy ships new files, so
// they never change while the server runs. next.config.ts traces both into the standalone build.
// Not covered by the node tests (they use loadPlans directly).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { loadPlans } from '@/lib/stepPlan';

function readOptional(file: string): string | null {
  try { return readFileSync(path.join(process.cwd(), 'config', file), 'utf8'); } catch { return null; }
}

const text = readOptional('plans.json');
export const loadedPlans = text === null
  ? (console.error('[plans] config/plans.json is missing, serving 500'), { ok: false as const, error: 'plans.json missing' })
  : loadPlans(text, readOptional('plans.json.sig'));
