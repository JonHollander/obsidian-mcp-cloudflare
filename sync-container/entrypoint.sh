#!/bin/bash
set -e

# ── Mount R2 via FUSE ───────────────────────────────────────────
# tigrisfs uses AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY from env
tigrisfs \
  --bucket "$R2_BUCKET_NAME" \
  --endpoint-url "https://${CF_ACCOUNT_ID}.r2.cloudflarestorage.com" \
  --mount-point /mnt/r2 \
  --allow-other &

sleep 2

# ── Authenticate with Obsidian ──────────────────────────────────
ob login --email "$OBSIDIAN_EMAIL" --password "$OBSIDIAN_PASSWORD"

# ── Setup vault (first run only) ────────────────────────────────
if [ ! -d "/vault/.obsidian-headless" ]; then
  cd /vault
  ob sync-setup --vault "$VAULT_NAME" --path /vault
  [ -n "$VAULT_PASSWORD" ] && ob sync-config --password "$VAULT_PASSWORD"
fi

# ── Mirror loop: local vault → R2 ───────────────────────────────
# ob writes to local /vault (ephemeral disk) to avoid sqlite-over-FUSE.
# rsync mirrors markdown files to /mnt/r2 (FUSE-mounted R2) every 10s.
(
  while true; do
    rsync -av \
      --include='*.md' --include='*/' --exclude='*' \
      --exclude='.obsidian*' \
      /vault/ /mnt/r2/
    sleep 10
  done
) &

# ── Run continuous sync ─────────────────────────────────────────
cd /vault
exec ob sync --continuous
