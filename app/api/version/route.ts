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

export async function GET() {
  const current = (process.env.BUILD_SHA ?? '').trim() || 'unknown';

  try {
    const res = await fetch('https://api.github.com/repos/frindle/resell-tracker/commits/main', {
      headers: { 'User-Agent': 'resell-tracker', Accept: 'application/vnd.github+json' },
      next: { revalidate: 300 }, // cache 5 min
    });
    if (!res.ok) {
      return Response.json({ version, current, latest: null, outdated: false } satisfies VersionResponse);
    }
    const data = await res.json() as { sha?: string; commit?: { committer?: { date?: string } } };
    const latest = (data.sha ?? '').slice(0, 7) || null;
    let outdated = current !== 'unknown' && latest !== null && current !== latest && !latest.startsWith(current);
    if (current === 'unknown' && latest !== null) {
      // No SHA baked — fall back to build-time vs latest-commit-date.
      // 5-minute slack absorbs the gap between committing and building.
      try {
        const builtAt = Date.parse(readFileSync(process.cwd() + '/.build-time', 'utf8').trim());
        const committedAt = Date.parse(data.commit?.committer?.date ?? '');
        if (!isNaN(builtAt) && !isNaN(committedAt)) {
          outdated = committedAt > builtAt + 5 * 60 * 1000;
        }
      } catch { /* no .build-time in image — stay non-outdated */ }
    }
    return Response.json({ version, current, latest, outdated } satisfies VersionResponse);
  } catch {
    return Response.json({ version, current, latest: null, outdated: false } satisfies VersionResponse);
  }
}
