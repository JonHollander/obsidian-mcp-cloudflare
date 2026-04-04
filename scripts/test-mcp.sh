#!/usr/bin/env bash
# Quick MCP endpoint test — initializes a session and calls list_notes

BASE_URL="${1:-https://obsidian-mcp.delicate-paper-b315.workers.dev/mcp}"
SESSION_ID=""

mcp_call() {
  local args=(-s -N --max-time 15 -X POST "$BASE_URL"
    -H "Content-Type: application/json"
    -H "Accept: application/json, text/event-stream"
    -D /tmp/mcp-headers.txt
    -d "$1")
  [ -n "$SESSION_ID" ] && args+=(-H "Mcp-Session-Id: $SESSION_ID")

  curl "${args[@]}" | while IFS= read -r line; do
    # Parse SSE: extract JSON from "data: {...}" lines
    if [[ "$line" == data:* ]]; then
      echo "${line#data: }"
    fi
  done
}

echo "── Initializing MCP session ─────────────────────────────"

INIT_RESPONSE=$(mcp_call '{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": "2025-03-26",
    "capabilities": {},
    "clientInfo": {"name": "test-mcp", "version": "1.0.0"}
  }
}')

echo "$INIT_RESPONSE" | python3 -m json.tool 2>/dev/null || echo "$INIT_RESPONSE"

# Extract session ID — look for the exact header name
SESSION_ID=$(grep -i "^mcp-session-id:" /tmp/mcp-headers.txt 2>/dev/null | tr -d '\r' | sed 's/^[^:]*: *//')

if [ -z "$SESSION_ID" ]; then
  echo "ERROR: No session ID returned. Headers:"
  cat /tmp/mcp-headers.txt 2>/dev/null
  exit 1
fi

echo ""
echo "Session: $SESSION_ID"
echo ""

echo "── Listing tools ────────────────────────────────────────"

TOOLS_RESPONSE=$(mcp_call '{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/list",
  "params": {}
}')

echo "$TOOLS_RESPONSE" | python3 -m json.tool 2>/dev/null || echo "$TOOLS_RESPONSE"
echo ""

echo "── Calling list_notes ───────────────────────────────────"

NOTES_RESPONSE=$(mcp_call '{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tools/call",
  "params": {"name": "list_notes", "arguments": {}}
}')

echo "$NOTES_RESPONSE" | python3 -m json.tool 2>/dev/null || echo "$NOTES_RESPONSE"
