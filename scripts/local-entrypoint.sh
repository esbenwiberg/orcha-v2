#!/bin/bash
set -e

# ── Seed local DB from ACA file share ────────────────────────────────────────
# If /mnt/aca is mounted and no local DB exists yet, pull config from ACA.
if [ -d "/mnt/aca" ]; then
  node scripts/seed-local.mjs
else
  echo "[local] no ACA mount at /mnt/aca — running with local data only"
fi

# ── Docker socket access (same as production entrypoint) ─────────────────────
if [ -S /var/run/docker.sock ]; then
  SOCK_GID=$(stat -c '%g' /var/run/docker.sock)
  if ! getent group "$SOCK_GID" >/dev/null 2>&1; then
    groupadd -g "$SOCK_GID" docker-host
  fi
  GROUP_NAME=$(getent group "$SOCK_GID" | cut -d: -f1)
  usermod -aG "$GROUP_NAME" orcha
  echo "[local] added orcha to group ${GROUP_NAME} (gid ${SOCK_GID}) for docker socket access"
fi

# ── Skip CLI updates for faster local startup ────────────────────────────────
# ACA entrypoint updates claude-code + vercel on every boot.
# Locally we skip this — you can update manually if needed.
echo "[local] skipping CLI updates (run 'npm i -g @anthropic-ai/claude-code' inside container to update)"

# ── Pre-create dotnet shm dir ────────────────────────────────────────────────
mkdir -p /tmp/.dotnet/shm
chown orcha:orcha /tmp/.dotnet/shm

exec gosu orcha node dist/web/start-server.js 2>&1
