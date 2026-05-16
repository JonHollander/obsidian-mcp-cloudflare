#!/bin/bash
LOG_FILE="/tmp/sync.log"
touch "$LOG_FILE"

echo "[sync] Container starting — pid $$" | tee -a "$LOG_FILE"

# ── HTTP API server on :8080 ────────────────────────────────────
node /app/server.js >> "$LOG_FILE" 2>&1 &
API_PID=$!

# ── Authenticate with Obsidian ──────────────────────────────────
echo "[sync] Logging in as $OBSIDIAN_EMAIL" | tee -a "$LOG_FILE"
if ob login --email "$OBSIDIAN_EMAIL" --password "$OBSIDIAN_PASSWORD" >> "$LOG_FILE" 2>&1; then
  echo "[sync] Obsidian login OK" | tee -a "$LOG_FILE"
else
  echo "[sync] ERROR: Obsidian login failed" | tee -a "$LOG_FILE"
  wait $API_PID
  exit 0
fi

# ── Setup vault (first run only) ────────────────────────────────
if [ ! -d "/vault/.obsidian-headless" ]; then
  echo "[sync] Setting up vault '$VAULT_NAME' at /vault" | tee -a "$LOG_FILE"
  SETUP_OK=false
  if [ -n "$VAULT_PASSWORD" ]; then
    if ob sync-setup --vault "$VAULT_NAME" --path /vault --password "$VAULT_PASSWORD" >> "$LOG_FILE" 2>&1; then
      SETUP_OK=true
    fi
  else
    if ob sync-setup --vault "$VAULT_NAME" --path /vault >> "$LOG_FILE" 2>&1; then
      SETUP_OK=true
    fi
  fi
  if [ "$SETUP_OK" != "true" ]; then
    echo "[sync] ERROR: Vault setup failed" | tee -a "$LOG_FILE"
    wait $API_PID
    exit 0
  fi
  echo "[sync] Vault setup OK" | tee -a "$LOG_FILE"
fi

# ── Signal readiness ────────────────────────────────────────────
touch /tmp/vault-ready
echo "[sync] Vault ready — API now serving requests" | tee -a "$LOG_FILE"

# ── Run continuous sync ─────────────────────────────────────────
echo "[sync] Starting ob sync --continuous" | tee -a "$LOG_FILE"
cd /vault
ob sync --continuous >> "$LOG_FILE" 2>&1
echo "[sync] ob sync exited with code $?" | tee -a "$LOG_FILE"

wait $API_PID
