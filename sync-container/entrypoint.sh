#!/bin/bash
echo "[sync] Container alive"

# Listen on port 33 — this is what the @cloudflare/containers
# framework checks internally for container readiness
node -e "
  require('http').createServer((req, res) => {
    res.writeHead(200);
    res.end('ok');
  }).listen(33, '0.0.0.0', () => {
    console.log('[sync] Listening on :33');
  });
"
