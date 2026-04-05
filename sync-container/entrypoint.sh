#!/bin/bash
LOG_FILE="/tmp/sync.log"
touch "$LOG_FILE"

echo "[sync] Container starting — pid $$" | tee -a "$LOG_FILE"

# ── HTTP server on :8080 (health check + log viewer) ──────────
node -e "
  const fs = require('fs');
  const http = require('http');
  http.createServer((req, res) => {
    if (req.url === '/logs') {
      res.writeHead(200, {'Content-Type':'text/plain'});
      try { res.end(fs.readFileSync('$LOG_FILE','utf8')); }
      catch(e) { res.end('(no logs yet)'); }
    } else if (req.url === '/status') {
      res.writeHead(200, {'Content-Type':'application/json'});
      let logs = '';
      try { logs = fs.readFileSync('$LOG_FILE','utf8'); } catch(e) {}
      res.end(JSON.stringify({
        pid: process.pid,
        uptime: process.uptime(),
        r2Mounted: logs.includes('R2 FUSE mount OK'),
        loginOk: logs.includes('Obsidian login OK'),
        syncRunning: logs.includes('Starting ob sync'),
        lastLines: logs.split('\\n').slice(-20)
      }));
    } else {
      res.writeHead(200);
      res.end('ok');
    }
  }).listen(8080, '0.0.0.0');
" &
HEALTH_PID=$!

# ── Mount R2 via FUSE ───────────────────────────────────────────
R2_ENDPOINT="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
echo "[sync] Mounting R2 bucket '$R2_BUCKET_NAME' at $R2_ENDPOINT" | tee -a "$LOG_FILE"
/usr/local/bin/tigrisfs --endpoint "$R2_ENDPOINT" -f "$R2_BUCKET_NAME" /mnt/r2 >> "$LOG_FILE" 2>&1 &

sleep 3

if mountpoint -q /mnt/r2 2>/dev/null; then
  echo "[sync] R2 FUSE mount OK" | tee -a "$LOG_FILE"
else
  echo "[sync] WARNING: R2 FUSE mount failed" | tee -a "$LOG_FILE"
fi

# ── Authenticate with Obsidian ──────────────────────────────────
echo "[sync] Logging in as $OBSIDIAN_EMAIL" | tee -a "$LOG_FILE"
if ob login --email "$OBSIDIAN_EMAIL" --password "$OBSIDIAN_PASSWORD" >> "$LOG_FILE" 2>&1; then
  echo "[sync] Obsidian login OK" | tee -a "$LOG_FILE"
else
  echo "[sync] ERROR: Obsidian login failed" | tee -a "$LOG_FILE"
  wait $HEALTH_PID
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
    wait $HEALTH_PID
    exit 0
  fi
  echo "[sync] Vault setup OK" | tee -a "$LOG_FILE"
fi

# ── rsync mirror loop: bidirectional /vault ↔ /mnt/r2 ────────────
(
  while true; do
    if mountpoint -q /mnt/r2 2>/dev/null; then
      rsync -a \
        --include='*.md' --include='*/' --exclude='*' \
        --exclude='.obsidian*' \
        /mnt/r2/ /vault/ 2>&1 | tee -a "$LOG_FILE" || echo "[sync] rsync R2→vault error" | tee -a "$LOG_FILE"
      rsync -a \
        --include='*.md' --include='*/' --exclude='*' \
        --exclude='.obsidian*' \
        /vault/ /mnt/r2/ 2>&1 | tee -a "$LOG_FILE" || echo "[sync] rsync vault→R2 error" | tee -a "$LOG_FILE"
    fi
    sleep 10
  done
) &
echo "[sync] rsync mirror loop started — bidirectional (every 10s)" | tee -a "$LOG_FILE"

# ── Run continuous sync ─────────────────────────────────────────
echo "[sync] Starting ob sync --continuous" | tee -a "$LOG_FILE"
cd /vault
ob sync --continuous >> "$LOG_FILE" 2>&1
echo "[sync] ob sync exited with code $?" | tee -a "$LOG_FILE"

wait $HEALTH_PID
