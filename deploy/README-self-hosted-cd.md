# resell-tracker self-hosted CD

Turns the last manual step (`update.sh` on Unraid) into automatic CD: every push
to `main` that passes typecheck+tests deploys itself.

## Pieces
- `.github/workflows/ci.yml` — new `deploy` job: `needs: typecheck`,
  `if: ref==main && push`, `runs-on: [self-hosted, unraid, resell]`, runs
  `/mnt/user/appdata/reselling/update.sh`.
- `deploy/gha-runner.compose.yml` — the runner container for Unraid.

## Order of operations (IMPORTANT)
1. Bring the runner ONLINE first (see the compose header).
2. Verify it's listed ONLINE with labels `self-hosted, unraid, resell`.
3. ONLY THEN merge `ci/self-hosted-deploy` → `main`.
   Merging before the runner is online makes the deploy job queue forever.

## Why update.sh (not a raw docker pull)
`update.sh` does `git fetch + reset --hard origin/main` (survives force-pushes)
AND sets `BUILD_SHA` so the NavBar "update available" badge works. Never replace
it with `git pull && docker-compose ...`.

## Security
No inbound exposure: the runner polls GitHub outbound. It has the docker socket,
so treat it as host-privileged — scope the registration token to this one repo.
