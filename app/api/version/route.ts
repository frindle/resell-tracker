import { version } from '@/package.json';
import { readFileSync } from 'fs';

export const dynamic = 'force-dynamic';

// Compares the running container's commit SHA (set at docker build time via
// the BUILD_SHA arg) against the latest main on GitHub. UI uses this to show
// an "Update available" badge.
//
// BUILD_SHA is wired in via:
//   docker-compose.yml → build.args.BUILD_SHA: "${BUILD_SHA:-unknown}"
//   Dockerfile          → ARG BUILD_SHA / ENV BUILD_SHA=$BUILD_SHA
//   docker update cmd   → BUILD_SHA=$(git rev-parse --short HEAD) docker-compose build
//
// When BUILD_SHA is "unknown" (not set in the build — e.g. a plain
// `docker-compose build` without update.sh) we fall back to comparing the
// image's baked build timestamp (/.build-time, written by the Dockerfile)
// against the latest main commit's date. A commit newer than the build
// means the container is outdated regardless of how it was built.

interface VersionResponse {
  version: string;        // package.json version, e.g. "1.1.0"
  current: string;        // current commit SHA (short) or "unknown"
  latest: string | null;  // latest main commit SHA (short), null when unknown
  outdated: boolean;
}

// Last good answer. GitHub's unauthenticated API allows 60 calls an hour per
// IP; when it refuses (rate limit, outage) the badge keeps its last known
// state instead of silently disappearing.
let lastGood: { current: string; latest: string | null; outdated: boolean; at: number } | null = null;
const FRESH_MS = 5 * 60 * 1000;

const GH = 'https://api.github.com/repos/frindle/resell-tracker';
const HEADERS = { 'User-Agent': 'resell-tracker', Accept: 'application/vnd.github+json' };

async function check(current: string): Promise<{ latest: string | null; outdated: boolean } | null> {
  if (current !== 'unknown') {
    // Ask GitHub how far main is ahead of this build. Comparing SHAs alone
    // flagged a fresh build as outdated while a cached "latest" was still
    // the commit before it.
    const res = await fetch(`${GH}/compare/${current}...main?per_page=1`, { headers: HEADERS, cache: 'no-store' });
    if (!res.ok) {
      console.warn(`[version] GitHub compare returned ${res.status}`);
      return null;
    }
    const d = await res.json() as { ahead_by?: number; commits?: { sha: string }[]; total_commits?: number };
    const ahead = d.ahead_by ?? 0;
    const head = await fetch(`${GH}/commits/main`, { headers: HEADERS, cache: 'no-store' }).then(r => r.ok ? r.json() : null).catch(() => null) as { sha?: string } | null;
    return { latest: (head?.sha ?? '').slice(0, 7) || (ahead > 0 ? null : current), outdated: ahead > 0 };
  }
  const res = await fetch(`${GH}/commits/main`, { headers: HEADERS, cache: 'no-store' });
  if (!res.ok) {
    console.warn(`[version] GitHub commits returned ${res.status}`);
    return null;
  }
  const data = await res.json() as { sha?: string; commit?: { committer?: { date?: string } } };
  const latest = (data.sha ?? '').slice(0, 7) || null;
  let outdated = false;
  // No SHA baked: compare build time with the latest commit's date. 5-minute
  // slack absorbs the gap between committing and building.
  try {
    const builtAt = Date.parse(readFileSync(process.cwd() + '/.build-time', 'utf8').trim());
    const committedAt = Date.parse(data.commit?.committer?.date ?? '');
    if (!isNaN(builtAt) && !isNaN(committedAt)) outdated = committedAt > builtAt + 5 * 60 * 1000;
  } catch { /* no .build-time in image: stay non-outdated */ }
  return { latest, outdated };
}

export async function GET() {
  const current = (process.env.BUILD_SHA ?? '').trim() || 'unknown';
  if (lastGood && lastGood.current === current && Date.now() - lastGood.at < FRESH_MS) {
    return Response.json({ version, current, latest: lastGood.latest, outdated: lastGood.outdated } satisfies VersionResponse);
  }
  const r = await check(current).catch(() => null);
  if (r) {
    lastGood = { current, ...r, at: Date.now() };
    return Response.json({ version, current, ...r } satisfies VersionResponse);
  }
  if (lastGood && lastGood.current === current) {
    return Response.json({ version, current, latest: lastGood.latest, outdated: lastGood.outdated } satisfies VersionResponse);
  }
  return Response.json({ version, current, latest: null, outdated: false } satisfies VersionResponse);
}
