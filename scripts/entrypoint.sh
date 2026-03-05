#!/bin/bash
set -e

# Update Claude Code to latest on every container boot.
# Runs before the Node server starts so sessions always get the newest CLI.
echo "[entrypoint] updating claude-code..."
if npm install -g @anthropic-ai/claude-code 2>&1; then
  echo "[entrypoint] claude-code updated to $(claude --version 2>/dev/null || echo 'unknown')"
else
  echo "[entrypoint] claude-code update failed, using cached version"
fi

exec node dist/web/start-server.js 2>&1
