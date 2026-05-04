# Obsidian + Claude via Cloudflare

Access your Obsidian vault from Claude (web, desktop, Code) using an MCP server
on Cloudflare Workers + Containers.

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
   serves vault files over HTTP API
        ▲
        │ container fetch (native)
        │
Cloudflare Worker (MCP server via Agents SDK)
   tools: list, read, search, write, append, delete
   auth via bearer token (or OAuth / Cloudflare Access)
        ▲
        │ MCP over Streamable HTTP
        │
Claude (web, desktop, Code)
```

The Container is the single source of truth. It runs `obsidian-headless` to sync
with Obsidian Sync and exposes an HTTP API for file operations. The Worker proxies
all MCP tool calls to the Container's API.

## MCP Tools

| Tool | Description |
|------|-------------|
| `list_notes` | List markdown notes with paths, sizes, dates. Supports `limit`, `cursor`, `prefix`, `updated_since`. |
| `read_note` | Read a note by path. Supports `offset` / `max_bytes` for paging through large notes. |
| `search_notes` | Full-text search across all notes with snippets. Supports `limit` (default 20). |
| `write_note` | Create or overwrite a note |
| `append_to_note` | Append to an existing note (or create it) |
| `delete_note` | Delete a note |
| `create_folder` | Create a folder (with intermediate directories) |
| `delete_folder` | Delete a folder (empty or recursive) |
| `list_folders` | List immediate subfolders at a path |

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

### 2. Configure Environment

Copy the example env file and fill in your values:

```bash
cp .dev.vars.example .dev.vars
```

Edit `.dev.vars` with your Obsidian credentials and optional MCP auth token.
This file is used by `wrangler dev` for local development and by the setup
script to push secrets to Cloudflare. It's already in `.gitignore`.

### 3. Deploy

Run the setup script to push all secrets and deploy:

```bash
./scripts/setup.sh
```

Or run steps individually:

```bash
./scripts/setup.sh secrets         # Push secrets to Cloudflare
./scripts/setup.sh validate        # Check prerequisites
./scripts/setup.sh deploy          # Validate + install deps + deploy + restart container
./scripts/setup.sh status          # Check sync container health
./scripts/setup.sh restart         # Restart sync container
./scripts/setup.sh container-logs  # View sync container logs
```

Your MCP server is live at:
`https://obsidian-mcp.<your-subdomain>.workers.dev/mcp`

### 4. Connect Claude

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
3. Next time Claude reads or searches, the Worker proxies the request to the
   Container's HTTP API which reads directly from `/vault`

### Claude creates a note:

1. Worker receives MCP `write_note` call
2. Worker proxies it to the Container's HTTP API
3. Container writes the file to `/vault`
4. `ob sync` detects the new file and pushes it via Obsidian Sync
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
| Container | 1 instance, mostly idle | Included in Workers plan |
| **Total additional** | | **$0** |

## Project Structure

```
obsidian-mcp/
├── src/
│   └── index.ts              # MCP server (Agents SDK, proxies to container)
├── sync-container/
│   ├── Dockerfile            # Headless sync container image
│   ├── entrypoint.sh         # Auth, sync startup
│   └── server.js             # HTTP API for vault file operations
├── scripts/
│   └── setup.sh              # Push secrets, deploy
├── .dev.vars.example         # Template for env vars / secrets
├── wrangler.jsonc            # Worker + Container config
└── package.json
```

## Next Steps

These are left as exercises to harden the setup for your needs:

### Auth Hardening

The included auth (`MCP_AUTH_TOKEN` secret) is **required** — the worker
returns 503 if it is unset or shorter than 16 characters. It supports both
`Authorization: Bearer` headers (preferred) and `?token=` query params.
The URL token approach is convenient for Claude.ai connectors where custom
headers aren't always available, but be aware: query-string tokens are
recorded in Cloudflare access logs, browser history, and `Referer` headers.
Prefer the header form when your client supports it, and rotate the token
periodically.

Generate a strong token with:

```bash
openssl rand -hex 32
```

For shared or public deployments, consider stronger options:

- **Cloudflare Access**: Put [Zero Trust Access](https://developers.cloudflare.com/cloudflare-one/policies/access/)
  in front of the Worker for identity-based SSO with audit logs and no code changes
- **OAuth**: Integrate [`workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider)
  for GitHub/Google OAuth flows

### Container Auth

Check whether `obsidian-headless` supports `--token` or env-var-based auth for
`ob login` to avoid interactive prompts. If not, persist the auth session from a
one-time interactive login and restore it on container start.

### Container Restart Resilience

The `ob` sqlite state file lives on ephemeral container disk. A restart triggers
a full re-sync. To fix: add a SIGTERM trap in `entrypoint.sh` that persists the
state file, and restore it on startup.

### Response & Result Limits

The container caps payload sizes to keep things responsive on large vaults.
Defaults can be overridden by setting environment variables on the container
(via `wrangler.jsonc` `vars` or per-container env):

| Variable | Default | Purpose |
|---|---|---|
| `MAX_BODY_BYTES` | `10485760` (10 MB) | Max accepted request body (returns 413 if exceeded). |
| `MAX_NOTE_BYTES` | `5242880` (5 MB) | Max bytes returned by `read_note`; clients page with `offset`. |
| `DEFAULT_LIST_LIMIT` / `MAX_LIST_LIMIT` | `1000` / `10000` | `list_notes` page size. |
| `DEFAULT_SEARCH_LIMIT` / `MAX_SEARCH_LIMIT` | `20` / `200` | `search_notes` result cap. |

### Search Performance

`search_notes` reads every `.md` file per query — fine for vaults up to a few
thousand notes, especially with the result cap above. For larger vaults,
build a search index in [D1](https://developers.cloudflare.com/d1/)
or [Workers KV](https://developers.cloudflare.com/kv/).

### Attachments

Currently filters to `.md` only — and the container also rejects writes,
appends, and deletes for any non-`.md` path, plus any path inside
`.obsidian/`, `.obsidian-*/`, or `.trash/`. This prevents a misbehaving
client from overwriting Obsidian config or community plugins (which would
let an attacker run code on your desktop the next time you open the vault).
To support additional file types, relax this guard deliberately and add
new tools.

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

## Component Reference

| Component | What it does |
|---|---|
| [`obsidian-headless`](https://www.npmjs.com/package/obsidian-headless) | Official Obsidian CLI, syncs vault headlessly |
| [`McpAgent`](https://developers.cloudflare.com/agents/model-context-protocol/mcp-agent-api/) (Agents SDK) | Handles MCP transport, sessions, auth |
| [`McpServer`](https://github.com/modelcontextprotocol/typescript-sdk) (MCP SDK) | Tool registration, JSON-RPC protocol |
| [Cloudflare Containers](https://developers.cloudflare.com/containers/) | Runs the sync process alongside the Worker |
