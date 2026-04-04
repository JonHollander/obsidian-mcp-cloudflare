#!/bin/bash
echo "[sync] Container alive — pid $$"

node -e "
  require('http').createServer((req, res) => {
    console.log('[sync] health check hit:', req.url);
    res.writeHead(200);
    res.end('ok');
  }).listen(8080, '0.0.0.0', () => {
    console.log('[sync] Listening on :8080');
  });
"
