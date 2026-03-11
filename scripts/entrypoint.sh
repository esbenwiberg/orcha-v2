#!/bin/bash
set -e

# Pre-create /tmp/.dotnet/shm so .NET named mutexes work under landlock.
# /tmp is ephemeral and cleared on container restart, so this must run at boot.
mkdir -p /tmp/.dotnet/shm
chown orcha:orcha /tmp/.dotnet/shm

# If the Docker socket is mounted, ensure the orcha user can access it.
# Detects the socket's GID and adds orcha to a matching group.
if [ -S /var/run/docker.sock ]; then
  SOCK_GID=$(stat -c '%g' /var/run/docker.sock)
  # Find or create a group with this GID
  if ! getent group "$SOCK_GID" >/dev/null 2>&1; then
    groupadd -g "$SOCK_GID" docker-host
  fi
  GROUP_NAME=$(getent group "$SOCK_GID" | cut -d: -f1)
  usermod -aG "$GROUP_NAME" orcha
  echo "[entrypoint] added orcha to group ${GROUP_NAME} (gid ${SOCK_GID}) for docker socket access"
fi

# Update Claude Code to latest on every container boot.
# Runs before the Node server starts so sessions always get the newest CLI.
echo "[entrypoint] updating claude-code..."
if gosu orcha npm install -g @anthropic-ai/claude-code 2>&1; then
  echo "[entrypoint] claude-code updated to $(gosu orcha claude --version 2>/dev/null || echo 'unknown')"
else
  echo "[entrypoint] claude-code update failed, using cached version"
fi

exec gosu orcha node dist/web/start-server.js 2>&1
