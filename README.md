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

### 3. Set Secrets

```bash
# Container secrets (Obsidian auth)
wrangler secret put OBSIDIAN_EMAIL
wrangler secret put OBSIDIAN_PASSWORD
wrangler secret put VAULT_NAME
wrangler secret put VAULT_PASSWORD        # if vault uses E2EE

# Container secrets (R2 FUSE mount)
wrangler secret put R2_ACCESS_KEY_ID
wrangler secret put R2_SECRET_ACCESS_KEY
wrangler secret put R2_BUCKET_NAME        # "obsidian-vault"
wrangler secret put CF_ACCOUNT_ID

# Optional: bearer token for MCP auth
wrangler secret put MCP_AUTH_TOKEN
```

### 4. Deploy

```bash
npm install
wrangler deploy
```

Your MCP server is live at:
`https://obsidian-mcp.<your-subdomain>.workers.dev/mcp`

### 5. Connect Claude

**Claude.ai (web)**

Settings → Integrations → Add custom integration:
- URL: `https://obsidian-mcp.<your-subdomain>.workers.dev/mcp`

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
├── wrangler.jsonc            # Worker + R2 + Container config
└── package.json
```

## Next Steps

These are left as exercises to harden the setup for your needs:

### Auth Hardening

The included bearer token auth (`MCP_AUTH_TOKEN` secret) works for personal use.
For shared or public deployments:

- **OAuth**: Integrate [`workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider)
  for GitHub/Google OAuth flows
- **Cloudflare Access**: Put [Zero Trust Access](https://developers.cloudflare.com/cloudflare-one/policies/access/)
  in front of the Worker for SSO with no code changes

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

## Component Reference

| Component | What it does |
|---|---|
| [`obsidian-headless`](https://www.npmjs.com/package/obsidian-headless) | Official Obsidian CLI, syncs vault headlessly |
| [`tigrisfs`](https://github.com/tigrisdata/tigrisfs) | FUSE adapter, mounts R2 as a local filesystem |
| [`McpAgent`](https://developers.cloudflare.com/agents/model-context-protocol/mcp-agent-api/) (Agents SDK) | Handles MCP transport, sessions, auth |
| [`McpServer`](https://github.com/modelcontextprotocol/typescript-sdk) (MCP SDK) | Tool registration, JSON-RPC protocol |
| [Cloudflare R2](https://developers.cloudflare.com/r2/) | Object storage, shared between Container and Worker |
| [Cloudflare Containers](https://developers.cloudflare.com/containers/) | Runs the sync process alongside the Worker |
