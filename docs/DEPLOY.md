# Deployment (Continuous Deployment)

Merges to `main` deploy themselves. Once the **CI `typecheck` job (tsc + `npm test`)
passes** on a push to `main`, a gated **`deploy`** job runs on a **self-hosted GitHub
Actions runner on the Unraid host** and executes the one true deploy script,
`/mnt/user/appdata/reselling/update.sh`.

No more manual `cd /mnt/user/appdata/reselling && ./update.sh` hand-off.

## Why this shape

- **Deploy must run ON Unraid.** The `reselling-app-1` container lives on Unraid;
  cloud runners can't reach it. So the deploy job is `runs-on: [self-hosted, unraid]`.
- **`needs: [typecheck]` + `if:` guard.** The deploy only runs after tests pass, and
  only on real pushes to `main` — never on PRs or other branches.
- **`update.sh` is the only correct deploy path.** It does `git fetch + reset --hard`
  (survives force-pushes) and sets `BUILD_SHA` so the NavBar "update available" badge
  works. The job calls it directly and does NOT check out code or run raw
  `git pull` / `docker-compose build`.
- **`concurrency: reselling-deploy` (cancel-in-progress: false).** Two quick merges
  won't build/restart on top of each other; an in-flight deploy finishes, then the
  next runs.

## Flow

```
push to main ──▶ CI: typecheck (tsc + npm test)  ──pass──▶ deploy (self-hosted, unraid)
                                                              └─ bash /mnt/user/appdata/reselling/update.sh
                                                                   ├─ git fetch + reset --hard origin/main
                                                                   ├─ docker-compose build app  (BUILD_SHA baked in)
                                                                   └─ docker-compose up -d --remove-orphans
```

## One-time setup: register the self-hosted runner on Unraid

The `deploy` job stays on the `ci/auto-deploy-runner` branch (it is NOT on `main` yet)
until the runner below shows as **Idle** in the repo runner list. A `runs-on: self-hosted`
job with no registered runner queues forever and pollutes every push, so register the
runner first.

### 1. Get a registration token

Repo **Settings → Actions → Runners → New self-hosted runner**. Copy the registration
token shown (it starts with `A...` and expires in ~1 hour). It is used once, at
container start, to register the runner.

### 2. Run the runner as a persistent Unraid container

Recommended image: [`myoung34/github-runner`](https://github.com/myoung34/docker-github-actions-runner)
(auto-registers from env vars, easy to run as an Unraid Docker container/service).

Run it on the Unraid host (SSH or the Unraid Docker UI → *Add Container* with these
same values). The `RUNNER_LABELS=unraid` label is what the `deploy` job targets, and
the docker socket + reselling appdata mounts let the runner run `update.sh` and drive
`docker-compose`:

```bash
docker run -d --restart always \
  --name gha-runner-reselling \
  -e REPO_URL="https://github.com/frindle/resell-tracker" \
  -e RUNNER_TOKEN="PASTE_REGISTRATION_TOKEN_HERE" \
  -e RUNNER_NAME="unraid-reselling" \
  -e RUNNER_LABELS="unraid" \
  -e RUNNER_WORKDIR="/tmp/gha-runner" \
  -e RUN_AS_ROOT="true" \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v /mnt/user/appdata/reselling:/mnt/user/appdata/reselling \
  -v /mnt/user/appdata/gha-runner-reselling:/tmp/gha-runner \
  myoung34/github-runner:latest
```

Notes:
- `RUNNER_TOKEN` is the **registration** token from step 1 (not a PAT). It's only
  needed at first start; the runner exchanges it for its own persistent credentials.
- The docker socket mount lets the runner call `docker-compose` exactly like a human
  on the host would. `update.sh` itself lives at the mounted appdata path.
- `--restart always` keeps the runner alive across reboots so future merges deploy
  unattended. In the Unraid Docker UI, set the container to autostart for the same
  effect.

> **Official runner alternative:** you can instead follow the tarball instructions on
> the *New self-hosted runner* page (`./config.sh --url https://github.com/frindle/resell-tracker
> --token <TOKEN> --labels unraid`, then `./run.sh` / install as a service). The
> Docker image above is preferred on Unraid because it survives reboots as a normal
> container.

### 3. Confirm and merge

- In **Settings → Actions → Runners**, wait for the runner to show as **Idle**
  (green) with the `unraid` label.
- Only then merge `ci/auto-deploy-runner` into `main`. From that point, every merge
  to `main` that passes CI deploys itself.
