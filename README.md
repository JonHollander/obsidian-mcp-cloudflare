# Obsidian + Claude via Cloudflare

Access your Obsidian vault from Claude (web, desktop, Code) using an MCP server
on Cloudflare Workers + Containers + R2.

No NAS, no Docker Compose, no tunnels. Just Cloudflare infrastructure with the
Agents SDK for a proper MCP server.

## Architecture

```
Obsidian (phone, desktop)
        │
        │ Obsidian Sync (your existing subscription)
        ▼
Cloudflare Container (Node.js 22)
   runs `ob sync --continuous`
   writes to R2 via FUSE mount
        │
        ▼
Cloudflare R2 (vault file storage)
        ▲
        │ R2 binding (native)
        │
Cloudflare Worker (MCP server via Agents SDK)
   tools: list, read, search, write, append, delete
   auth via bearer token (or OAuth / Cloudflare Access)
        ▲
        │ MCP over Streamable HTTP
        │
Claude (web, desktop, Code)
```

The Container and Worker both access the same R2 bucket — the Container via
FUSE-mounted filesystem, the Worker via its R2 binding.

## MCP Tools

| Tool | Description |
|------|-------------|
| `list_notes` | List all markdown notes with paths, sizes, and dates |
| `read_note` | Read the full content of a note by path |
| `search_notes` | Full-text search across all notes with snippets |
| `write_note` | Create or overwrite a note |
| `append_to_note` | Append to an existing note (or create it) |
| `delete_note` | Delete a note |

## Prerequisites

- Cloudflare account with Workers Paid plan ($5/month)
- Active [Obsidian Sync](https://obsidian.md/sync) subscription
- Node.js 22+ on your workstation
- `wrangler` CLI: `npm install -g wrangler`

## Setup

### 0. Wrangler Login

```bash
wrangler login
```

All required scopes are granted by default.

### 1. Generate Obsidian Auth Token

One-time step on your workstation:

```bash
npm install -g obsidian-headless

ob login
# Enter email, password, MFA code if enabled

ob sync-list-remote
# Note your vault name
```

### 2. Create the R2 Bucket

```bash
wrangler r2 bucket create obsidian-vault
```

Create an R2 API token for the Container's FUSE mount:

1. Cloudflare dashboard → R2 → Overview → Manage R2 API Tokens
2. Create token with **Object Read & Write** on `obsidian-vault`
3. Save the Access Key ID and Secret Access Key

### 3. Configure Environment

Copy the example env file and fill in your values:

```bash
cp .dev.vars.example .dev.vars
```

Edit `.dev.vars` with your Cloudflare account ID, R2 credentials, and Obsidian
auth. This file is used by `wrangler dev` for local development and by the
setup script to push secrets to Cloudflare. It's already in `.gitignore`.

### 4. Deploy

Run the setup script to create the R2 bucket, push all secrets, and deploy:

```bash
./scripts/setup.sh
```

Or run steps individually:

```bash
./scripts/setup.sh bucket          # Create R2 bucket
./scripts/setup.sh secrets         # Push secrets to Cloudflare
./scripts/setup.sh validate        # Check prerequisites
./scripts/setup.sh deploy          # Validate + install deps + deploy + restart container
./scripts/setup.sh status          # Check sync container health
./scripts/setup.sh restart         # Restart sync container
./scripts/setup.sh container-logs  # View sync container logs
```

Your MCP server is live at:
`https://obsidian-mcp.<your-subdomain>.workers.dev/mcp`

### 5. Connect Claude

**Claude.ai (web)**

Settings → Connectors → Add custom connector:
- URL: `https://obsidian-mcp.<your-subdomain>.workers.dev/mcp?token=YOUR_MCP_AUTH_TOKEN`
- Leave OAuth fields blank — the token in the URL handles auth

**Claude Code**

```bash
claude mcp add \
  --transport http \
  --scope user \
  obsidian-vault \
  https://obsidian-mcp.<your-subdomain>.workers.dev/mcp
```

**Claude Desktop**

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "obsidian-vault": {
      "url": "https://obsidian-mcp.<your-subdomain>.workers.dev/mcp"
    }
  }
}
```

## How Data Flows

### You edit a note on your phone:

1. Obsidian Sync pushes the change
2. Container's `ob sync --continuous` pulls it to `/vault`
3. rsync mirrors it to `/mnt/r2` (R2 via FUSE)
4. Next time Claude reads or searches, it sees the update via R2 binding

### Claude creates a note:

1. Worker writes to R2 via binding (`VAULT.put()`)
2. Container's FUSE mount sees the new file on R2
3. rsync picks it up (or `ob sync` detects it if writing directly)
4. `ob sync` pushes it upstream via Obsidian Sync
5. It appears on your phone and desktop

## Development

```bash
# Local dev (MCP server only, no container)
npm run dev

# Deploy
npm run deploy
```

## Cost

| Service | Usage | Cost |
|---|---|---|
| Workers Paid Plan | Already paying | $5/month (covers everything) |
| R2 | Markdown vault, <100MB | Free tier (10GB included) |
| Container | 1 instance, mostly idle | Included in Workers plan |
| **Total additional** | | **$0** |

## Project Structure

```
obsidian-mcp/
├── src/
│   └── index.ts              # MCP server (Agents SDK + R2)
├── sync-container/
│   ├── Dockerfile            # Headless sync + FUSE mount
│   └── entrypoint.sh         # Auth, mount, sync, mirror
├── scripts/
│   └── setup.sh              # Create bucket, push secrets, deploy
├── .dev.vars.example         # Template for env vars / secrets
├── wrangler.jsonc            # Worker + R2 + Container config
└── package.json
```

## Next Steps

These are left as exercises to harden the setup for your needs:

### Auth Hardening

The included auth (`MCP_AUTH_TOKEN` secret) supports both `Authorization: Bearer`
headers and `?token=` query params. The URL token approach is convenient for
Claude.ai connectors where custom headers aren't always available.

For shared or public deployments, consider stronger options:

- **Cloudflare Access**: Put [Zero Trust Access](https://developers.cloudflare.com/cloudflare-one/policies/access/)
  in front of the Worker for identity-based SSO with audit logs and no code changes
- **OAuth**: Integrate [`workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider)
  for GitHub/Google OAuth flows

### Container Auth

Check whether `obsidian-headless` supports `--token` or env-var-based auth for
`ob login` to avoid interactive prompts. If not, persist the auth session from a
one-time interactive login to an R2 object and restore it on container start.

### Container Restart Resilience

The `ob` sqlite state file lives on ephemeral container disk. A restart triggers
a full re-sync. To fix: add a SIGTERM trap in `entrypoint.sh` that uploads the
state file to R2, and restore it on startup.

### Search Performance

The brute-force search reads every `.md` from R2 per query — fine for <500 files.
For larger vaults, build a search index in [D1](https://developers.cloudflare.com/d1/)
or [Workers KV](https://developers.cloudflare.com/kv/), updated by the rsync loop.

### Bidirectional Sync Conflicts

MCP `write_note` writes directly to R2 while the container's rsync also writes.
Options: write to a staging prefix (`_incoming/`), use R2 event notifications, or
add last-modified checks before writes.

### Attachments

Currently filters to `.md` only. Extend to support images, PDFs, and other
vault attachments with additional tools.

## Troubleshooting

**Docker must be running** — The sync container requires Docker. Run `docker info`
to verify. The `validate` subcommand checks this automatically.

**Two passwords** — `OBSIDIAN_PASSWORD` is your Obsidian account password (used
to log in at obsidian.md). `VAULT_PASSWORD` is the separate end-to-end encryption
password set in Obsidian → Sync → Encryption. Leave `VAULT_PASSWORD` empty if
your vault doesn't use E2EE.

**Deploy doesn't restart containers** — `wrangler deploy` does not restart running
containers. The setup script handles this automatically. If deploying manually,
restart with `./scripts/setup.sh restart`.

**Container logs not in wrangler tail** — Container stdout is not streamed through
`wrangler tail`. Use `./scripts/setup.sh container-logs` instead.

**Build fails at tigrisfs** — The FUSE mount binary is fetched during Docker build.
Check your network and Docker setup. The version is pinned in the Dockerfile.

## Component Reference

| Component | What it does |
|---|---|
| [`obsidian-headless`](https://www.npmjs.com/package/obsidian-headless) | Official Obsidian CLI, syncs vault headlessly |
| [`tigrisfs`](https://github.com/tigrisdata/tigrisfs) | FUSE adapter, mounts R2 as a local filesystem |
| [`McpAgent`](https://developers.cloudflare.com/agents/model-context-protocol/mcp-agent-api/) (Agents SDK) | Handles MCP transport, sessions, auth |
| [`McpServer`](https://github.com/modelcontextprotocol/typescript-sdk) (MCP SDK) | Tool registration, JSON-RPC protocol |
| [Cloudflare R2](https://developers.cloudflare.com/r2/) | Object storage, shared between Container and Worker |
| [Cloudflare Containers](https://developers.cloudflare.com/containers/) | Runs the sync process alongside the Worker |
