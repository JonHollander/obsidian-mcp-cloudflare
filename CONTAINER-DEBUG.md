# Container Debugging Handoff

## What Works

- **MCP server is live and functional** at `https://obsidian-mcp.delicate-paper-b315.workers.dev/mcp`
- Claude.ai connects via custom connector (Settings → Connectors)
- All 6 MCP tools work: `list_notes`, `read_note`, `search_notes`, `write_note`, `append_to_note`, `delete_note`
- Tools read/write to the R2 bucket `obsidian-vault` via native R2 binding
- TypeScript compiles cleanly, deploy succeeds

## What Doesn't Work

The **sync container** (ObsidianSync) never starts successfully. Its job is to run `obsidian-headless` (`ob sync --continuous`) and mirror the vault to R2 via FUSE. Without it, the R2 bucket only has files created by the MCP tools — no sync from the actual Obsidian vault.

## The Problem

The `@cloudflare/containers` package has a **hardcoded port 33 health check** in its `startContainer` method:

```javascript
// node_modules/@cloudflare/containers/dist/index.js, line 360
const port = this.container.getTcpPort(33);
```

This is unrelated to `defaultPort` — it's an internal readiness probe. The framework sends a fetch to port 33 and considers the container "ready" only if:
1. Port 33 responds, OR
2. Port 33 gives "not listening" error BUT the container is still running (line 365-366)

Our container crashes before this check passes, causing a `blockConcurrencyWhile` timeout that resets the Durable Object.

## What We've Tried

### Container configurations tested:
1. **Full Dockerfile** (node:22-slim + fuse3 + tigrisfs + obsidian-headless) → exit code 2
2. **Without tigrisfs** (node:22-slim + fuse3 + obsidian-headless) → exit code 2
3. **Without fuse3** (node:22-slim + obsidian-headless) → exit code 2
4. **Bare minimum** (node:22-slim, just a node HTTP server on :8080) → no container errors in logs, but container also never visibly starts (no `[sync]` log output appears)
5. **Bare minimum on port 33** (matching the hardcoded check) → same failure
6. **Deleted container + redeployed** → "There is no container instance that can be provided to this Durable Object"

### Container class configurations tested:
- `defaultPort = 8080` as class property
- `defaultPort` via constructor options `super(ctx, env, { defaultPort: 8080 })`
- `enableInternet = true` as property and via options
- `envVars` as class property (matching official R2 FUSE example pattern)
- `envVars` in constructor
- `sleepAfter = "0s"` (always running)

### Startup trigger approaches:
- `waitUntil(getContainer().fetch())` in Worker fetch handler → times out, kills container
- Dedicated `/sync/start` endpoint with `getContainer().fetch()` → blocks forever, 1101 error
- Automatic startup (default, `manualStart = false`) → same port 33 failure

## Key Observations

1. **No container stdout/stderr visible** — none of our `echo` or `console.log` statements ever appear in `wrangler tail` logs. The entrypoint may never execute.
2. **Port 33 is hardcoded** in the `@cloudflare/containers` package, not configurable
3. The **bare minimum container didn't show errors** initially, but that's because the container DO was never triggered (the `waitUntil` was removed at that point). When triggered via `/sync/start`, it still fails.
4. After deleting the container image via `wrangler containers delete`, the DO enters a "no container instance" state.

## Current File State

### `src/index.ts`
- `ObsidianMCP extends McpAgent<Env>` — works perfectly
- `ObsidianSync extends Container<Env>` — never successfully starts
- Default export has `/sync/start` endpoint and MCP route

### `sync-container/Dockerfile` (currently bare minimum)
```dockerfile
FROM node:22-slim
RUN mkdir -p /vault /mnt/r2
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
EXPOSE 33
ENTRYPOINT ["/entrypoint.sh"]
```

### `sync-container/entrypoint.sh` (currently bare minimum)
```bash
#!/bin/bash
echo "[sync] Container alive"
node -e "
  require('http').createServer((req, res) => {
    res.writeHead(200);
    res.end('ok');
  }).listen(33, '0.0.0.0', () => {
    console.log('[sync] Listening on :33');
  });
"
```

### `wrangler.jsonc`
```jsonc
{
  "name": "obsidian-mcp",
  "main": "src/index.ts",
  "compatibility_date": "2025-04-01",
  "compatibility_flags": ["nodejs_compat"],
  "r2_buckets": [{ "binding": "VAULT", "bucket_name": "obsidian-vault" }],
  "durable_objects": {
    "bindings": [
      { "name": "MCP_OBJECT", "class_name": "ObsidianMCP" },
      { "name": "OBSIDIAN_SYNC", "class_name": "ObsidianSync" }
    ]
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["ObsidianMCP", "ObsidianSync"] }],
  "containers": [{ "class_name": "ObsidianSync", "image": "./sync-container", "max_instances": 1 }]
}
```

## Possible Next Steps

1. **Switch to low-level DO container API** — bypass `@cloudflare/containers` entirely, use `this.ctx.container.start()` and `this.ctx.container.getTcpPort()` directly. This avoids the port 33 health check and `blockConcurrencyWhile` timeout.

2. **Test container image locally** — `cd sync-container && docker build -t test . && docker run --rm test` to verify the image builds and entrypoint runs at all.

3. **Check if Cloudflare Containers (beta) has a known issue** with the `@cloudflare/containers` package version 0.0.4 and the port 33 probe.

4. **Try a completely different approach** — skip the container entirely, run `obsidian-headless` sync as a cron job or external process that uploads to R2 via the S3 API.

## Environment

- wrangler 4.80.0
- @cloudflare/containers 0.0.4
- agents 0.0.98
- Cloudflare account: `9551f3fca34f112d7208f23d42ce53fa`
- Worker: `obsidian-mcp.delicate-paper-b315.workers.dev`
