import { version } from '@/package.json';

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
// When BUILD_SHA is "unknown" (not set in the build) we fall back to comparing
// the package.json version against the latest GitHub tag — same behavior as
// the original implementation.

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
    const data = await res.json() as { sha?: string };
    const latest = (data.sha ?? '').slice(0, 7) || null;
    const outdated = current !== 'unknown' && latest !== null && current !== latest && !latest.startsWith(current);
    return Response.json({ version, current, latest, outdated } satisfies VersionResponse);
  } catch {
    return Response.json({ version, current, latest: null, outdated: false } satisfies VersionResponse);
  }
}
