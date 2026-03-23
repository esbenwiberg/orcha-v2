#!/bin/bash
set -e

# Orcha Local — start or reset your local Docker instance.
#
# Usage:
#   ./scripts/local.sh              Start Orcha locally (seeds from ACA on first run)
#   ./scripts/local.sh --reset      Wipe local DB and re-seed from ACA
#   ./scripts/local.sh --stop       Stop the local instance
#
# Prerequisites:
#   - Azure File Share mounted (default Z:/ on Windows, /mnt/aca on Linux)
#   - .env file with SESSION_SECRET=<same as ACA>
#
# Environment overrides:
#   LOCAL_PORT              Host port (default: 3001)
#   MAX_CONCURRENT_SESSIONS Max agent sessions (default: 3)
#   ACA_MOUNT_PATH          AFS mount path (default: Z:/ on Windows, /mnt/aca on Linux)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
COMPOSE_FILE="$PROJECT_DIR/docker-compose.local.yml"
DATA_DIR="$PROJECT_DIR/data-local"

cd "$PROJECT_DIR"

# ── Detect OS for mount path default ─────────────────────────────────────────
if [[ "$(uname -s)" == MINGW* || "$(uname -s)" == MSYS* || "$(uname -s)" == CYGWIN* ]]; then
  DEFAULT_MOUNT="Z:/"
else
  DEFAULT_MOUNT="/mnt/aca"
fi
export ACA_MOUNT_PATH="${ACA_MOUNT_PATH:-$DEFAULT_MOUNT}"

# ── Commands ─────────────────────────────────────────────────────────────────

case "${1:-start}" in
  --reset|-r)
    echo "==> Resetting local Orcha..."
    docker compose -f "$COMPOSE_FILE" down 2>/dev/null || true

    if [ -f "$DATA_DIR/orcha.db" ]; then
      rm -f "$DATA_DIR/orcha.db" "$DATA_DIR/orcha.db-wal" "$DATA_DIR/orcha.db-shm"
      echo "    Deleted local DB"
    fi

    if [ -d "$DATA_DIR/bare-repos" ]; then
      rm -rf "$DATA_DIR/bare-repos"
      echo "    Deleted bare repos (will re-clone)"
    fi

    echo "    Starting fresh..."
    docker compose -f "$COMPOSE_FILE" up --build -d
    echo ""
    echo "==> Reset complete. Orcha seeding from ACA..."
    echo "    http://localhost:${LOCAL_PORT:-3001}"
    docker compose -f "$COMPOSE_FILE" logs -f
    ;;

  --stop|-s)
    echo "==> Stopping local Orcha..."
    docker compose -f "$COMPOSE_FILE" down
    echo "    Stopped."
    ;;

  start|"")
    # Check .env exists
    if [ ! -f "$PROJECT_DIR/.env" ] && [ -z "$SESSION_SECRET" ]; then
      echo "ERROR: No .env file and SESSION_SECRET not set."
      echo ""
      echo "Create a .env file:"
      echo "  echo 'SESSION_SECRET=<your-aca-secret>' > .env"
      echo ""
      echo "Or get it from ACA:"
      echo "  az containerapp show -n orcha -g <rg> --query \"properties.configuration.secrets[?name=='session-secret'].value\" -o tsv"
      exit 1
    fi

    # Check mount is accessible
    if [ ! -d "$ACA_MOUNT_PATH" ] && [ ! -f "$DATA_DIR/orcha.db" ]; then
      echo "WARNING: ACA mount not found at $ACA_MOUNT_PATH and no local DB exists."
      echo "         Orcha will start fresh without ACA config."
      echo ""
      echo "To mount Azure File Share:"
      if [[ "$DEFAULT_MOUNT" == "Z:/" ]]; then
        echo '  net use Z: \\<acct>.file.core.windows.net\orcha-data /user:AZURE\<acct> <key> /persistent:yes'
      else
        echo "  sudo mount -t cifs //<acct>.file.core.windows.net/orcha-data /mnt/aca -o username=<acct>,password=<key>,vers=3.0,readonly"
      fi
      echo ""
      read -rp "Continue anyway? [y/N] " confirm
      [[ "$confirm" =~ ^[Yy]$ ]] || exit 0
    fi

    echo "==> Starting local Orcha..."
    docker compose -f "$COMPOSE_FILE" up --build -d
    echo ""
    echo "==> Orcha is starting at http://localhost:${LOCAL_PORT:-3001}"
    echo "    Logs: docker compose -f docker-compose.local.yml logs -f"
    echo "    Stop: ./scripts/local.sh --stop"
    echo "    Reset: ./scripts/local.sh --reset"
    docker compose -f "$COMPOSE_FILE" logs -f
    ;;

  *)
    echo "Usage: ./scripts/local.sh [--reset | --stop]"
    echo ""
    echo "  (no args)   Start Orcha locally (seeds from ACA on first run)"
    echo "  --reset     Wipe local DB + repos, re-seed from ACA"
    echo "  --stop      Stop the local instance"
    exit 1
    ;;
esac
