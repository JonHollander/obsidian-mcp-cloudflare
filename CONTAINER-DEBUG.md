# Container Debug — Resolved

## Issues Found & Fixed

### 1. `@cloudflare/containers` v0.0.4 — hardcoded port 33 health check
The old package version hardcoded port 33 in its startup health check (`#startContainerIfNotRunning`), ignoring `defaultPort`. The constructor also aggressively auto-started the container with a 25s timeout.

**Fix:** Upgraded to v0.2.2, which respects `defaultPort` and doesn't auto-start in the constructor.

### 2. `sleepAfter = "0s"` killed the container immediately
`"0s"` means "sleep after 0 seconds of inactivity" — the container was stopped by the inactivity timer as soon as it started.

**Fix:** Changed to `sleepAfter = "24h"`.

### 3. Entrypoint port mismatch
The entrypoint listened on port 33 but `defaultPort` was 8080.

**Fix:** Aligned both to port 8080.

### 4. Docker build failure — flaky GitHub API call for tigrisfs
The Dockerfile fetched the latest tigrisfs version from the GitHub API at build time, which intermittently failed (exit code 6).

**Fix:** Pinned tigrisfs to `v1.2.1` via `ARG TIGRISFS_VERSION=v1.2.1`.

### 5. E2EE vault password not passed to `ob sync-setup`
The entrypoint called `ob sync-setup` without `--password`, then tried to set the password afterward via `ob sync-config`. The `sync-setup` command needs the E2EE password inline.

**Fix:** Pass `--password "$VAULT_PASSWORD"` directly to `ob sync-setup`.

## Container Management Endpoints

- `GET /sync/start` — Start the container (or confirm it's running)
- `GET /sync/restart` — Destroy and recreate the container (picks up new image/secrets)
- `GET /sync/logs` — Read the container's internal log file
- `GET /sync/status` — JSON summary of container state

## Notes

- `wrangler deploy` pushes new Worker code and container images, but does **not** restart running containers. Use `/sync/restart` after deploy to pick up changes.
- Container stdout/stderr is not visible in `wrangler tail`. Use `/sync/logs` instead.
- The `OBSIDIAN_PASSWORD` (account) and `VAULT_PASSWORD` (E2EE encryption) are different credentials.
