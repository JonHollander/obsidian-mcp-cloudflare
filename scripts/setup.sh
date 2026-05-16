#!/usr/bin/env bash
set -euo pipefail

# Obsidian Cloud MCP — Setup Script
# Reads .dev.vars and pushes secrets to Cloudflare, creates R2 bucket, etc.
#
# Usage:
#   ./scripts/setup.sh              # Run full setup
#   ./scripts/setup.sh secrets      # Only push secrets
#   ./scripts/setup.sh deploy       # Only deploy worker
#   ./scripts/setup.sh deploy --log # Deploy then tail live logs
#   ./scripts/setup.sh logs         # Tail live logs only

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
DEV_VARS="$PROJECT_DIR/.dev.vars"

# ── Load .dev.vars ──────────────────────────────────────────────

if [ ! -f "$DEV_VARS" ]; then
  echo "Error: .dev.vars not found. Copy the example and fill in your values:"
  echo "  cp .dev.vars.example .dev.vars"
  exit 1
fi

# Source .dev.vars (skip comments and blank lines)
set -a
while IFS= read -r line; do
  # Skip comments and empty lines
  [[ "$line" =~ ^[[:space:]]*# ]] && continue
  [[ -z "${line// }" ]] && continue
  eval "$line"
done < "$DEV_VARS"
set +a

# ── Helpers ─────────────────────────────────────────────────────

auth_curl() {
  # curl with auth token if set
  local token="${MCP_AUTH_TOKEN:-}"
  if [ -n "$token" ]; then
    curl -s -H "Authorization: Bearer $token" "$@"
  else
    curl -s "$@"
  fi
}

push_secret() {
  local name="$1"
  local value="${!name:-}"
  if [ -z "$value" ]; then
    echo "  ⏭  $name (empty, skipping)"
    return
  fi
  echo "$value" | wrangler secret put "$name" --name obsidian-mcp 2>&1 | tail -1
  echo "  ✓  $name"
}

# ── Commands ────────────────────────────────────────────────────

do_secrets() {
  echo "── Pushing secrets to Cloudflare ──────────────────────"
  push_secret OBSIDIAN_EMAIL
  push_secret OBSIDIAN_PASSWORD
  push_secret VAULT_NAME
  push_secret VAULT_PASSWORD
  push_secret MCP_AUTH_TOKEN
  push_secret SEARCH_INDEX_ENABLED
}

do_validate() {
  echo "── Validating prerequisites ───────────────────────────"
  local ok=true

  if ! docker info &>/dev/null; then
    echo "  ✗ Docker is not running"
    ok=false
  else
    echo "  ✓ Docker"
  fi

  local node_ver
  node_ver=$(node --version 2>/dev/null | sed 's/v//' | cut -d. -f1)
  if [ -z "$node_ver" ] || [ "$node_ver" -lt 22 ]; then
    echo "  ✗ Node.js 22+ required (found: ${node_ver:-none})"
    ok=false
  else
    echo "  ✓ Node.js $(node --version)"
  fi

  if ! npx wrangler --version &>/dev/null; then
    echo "  ✗ wrangler not found"
    ok=false
  else
    echo "  ✓ wrangler $(npx wrangler --version 2>/dev/null | head -1)"
  fi

  if [ ! -f "$DEV_VARS" ]; then
    echo "  ✗ .dev.vars not found"
    ok=false
  else
    local missing=()
    for var in OBSIDIAN_EMAIL OBSIDIAN_PASSWORD VAULT_NAME; do
      local val="${!var:-}"
      if [ -z "$val" ] || [[ "$val" == your-* ]]; then
        missing+=("$var")
      fi
    done
    if [ ${#missing[@]} -gt 0 ]; then
      echo "  ✗ .dev.vars missing or placeholder values: ${missing[*]}"
      ok=false
    else
      echo "  ✓ .dev.vars"
    fi
  fi

  if [ "$ok" = false ]; then
    echo ""
    echo "  Fix the issues above before deploying."
    return 1
  fi
  echo "  All checks passed."
}

do_deploy() {
  echo "── Deploying worker ───────────────────────────────────"
  cd "$PROJECT_DIR"
  npm install
  npx wrangler deploy 2>&1 | tee /tmp/obsidian-mcp-deploy.log

  # Extract the worker URL from deploy output
  local worker_url
  worker_url=$(grep -oP 'https://[^\s]+\.workers\.dev' /tmp/obsidian-mcp-deploy.log | head -1)
  if [ -z "$worker_url" ]; then
    echo "  ERROR: Deploy failed — check output above"
    return 1
  fi
  WORKER_URL="$worker_url"
  echo "$worker_url" > "$WORKER_URL_FILE"

  echo ""
  echo "── Restarting sync container ──────────────────────────"
  echo "  (wrangler deploy does not restart running containers)"
  auth_curl "${worker_url}/sync/restart" | python3 -m json.tool 2>/dev/null || true
  sleep 5

  echo ""
  echo "── Verifying container health ─────────────────────────"
  auth_curl "${worker_url}/sync/status" | python3 -m json.tool 2>/dev/null || echo "  (container starting...)"

  echo ""
  echo "════════════════════════════════════════════════════════"
  echo "  MCP server URL (paste into Claude connectors):"
  echo ""
  echo "  ${worker_url}/mcp"
  echo "════════════════════════════════════════════════════════"
}

do_logs() {
  echo "── Tailing live logs (Ctrl+C to stop) ─────────────────"
  echo "  Trigger the container by making an MCP request"
  echo "  (e.g. ./scripts/test-mcp.sh)"
  echo ""
  wrangler tail obsidian-mcp --format pretty
}

# ── Worker URL helper ──────────────────────────────────────────

WORKER_URL_FILE="$PROJECT_DIR/.worker-url"

get_worker_url() {
  if [ -n "${WORKER_URL:-}" ]; then
    echo "$WORKER_URL"
    return
  fi
  if [ -f "$WORKER_URL_FILE" ]; then
    cat "$WORKER_URL_FILE"
    return
  fi
  echo "Error: Worker URL not known. Run './scripts/setup.sh deploy' first." >&2
  return 1
}

# ── Container management ───────────────────────────────────────

do_restart() {
  local url
  url="$(get_worker_url)"
  echo "── Restarting sync container ──────────────────────────"
  auth_curl "${url}/sync/restart" | python3 -m json.tool 2>/dev/null || echo "  Failed to reach ${url}/sync/restart"
}

do_status() {
  local url
  url="$(get_worker_url)"
  echo "── Container status ───────────────────────────────────"
  auth_curl "${url}/sync/status" | python3 -m json.tool 2>/dev/null || echo "  Failed to reach ${url}/sync/status"
}

do_container_logs() {
  local url
  url="$(get_worker_url)"
  echo "── Container logs ─────────────────────────────────────"
  auth_curl "${url}/sync/logs" || echo "  Failed to reach ${url}/sync/logs"
}

# ── Main ────────────────────────────────────────────────────────

case "${1:-all}" in
  secrets)
    do_secrets
    ;;
  validate)
    do_validate
    ;;
  deploy)
    do_validate
    echo ""
    do_deploy
    [[ "${2:-}" == "--log" ]] && do_logs
    ;;
  logs)
    do_logs
    ;;
  restart)
    do_restart
    ;;
  status)
    do_status
    ;;
  container-logs)
    do_container_logs
    ;;
  all)
    do_validate
    echo ""
    do_secrets
    echo ""
    do_deploy
    [[ "${2:-}" == "--log" ]] && do_logs
    ;;
  *)
    echo "Usage: $0 [secrets|deploy|logs|validate|restart|status|container-logs|all] [--log]"
    exit 1
    ;;
esac
