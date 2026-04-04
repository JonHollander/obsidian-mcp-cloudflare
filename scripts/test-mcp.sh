#!/usr/bin/env bash
# Quick MCP endpoint test — initializes a session and calls list_notes

BASE_URL="${1:-https://obsidian-mcp.delicate-paper-b315.workers.dev/mcp}"

mcp_call() {
  local session_header=""
  [ -n "${SESSION_ID:-}" ] && session_header="-H Mcp-Session-Id: $SESSION_ID"
  curl -s -N --max-time 15 -X POST "$BASE_URL" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    ${session_header:+-H "Mcp-Session-Id: $SESSION_ID"} \
    -D /tmp/mcp-headers.txt \
    -d "$1" | while IFS= read -r line; do
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

SESSION_ID=$(grep -i "mcp-session-id" /tmp/mcp-headers.txt 2>/dev/null | tr -d '\r' | awk '{print $2}')

if [ -z "$SESSION_ID" ]; then
  echo "ERROR: No session ID returned."
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
