#!/bin/bash
set -e

# Pre-create /tmp/.dotnet/shm so .NET named mutexes work under landlock.
# /tmp is ephemeral and cleared on container restart, so this must run at boot.
mkdir -p /tmp/.dotnet/shm

# Update Claude Code to latest on every container boot.
# Runs before the Node server starts so sessions always get the newest CLI.
echo "[entrypoint] updating claude-code..."
if npm install -g @anthropic-ai/claude-code 2>&1; then
  echo "[entrypoint] claude-code updated to $(claude --version 2>/dev/null || echo 'unknown')"
else
  echo "[entrypoint] claude-code update failed, using cached version"
fi

exec node dist/web/start-server.js 2>&1
