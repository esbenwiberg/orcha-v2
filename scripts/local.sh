#!/bin/bash
set -e

# Orcha Local — start or reset your local Docker instance.
#
# Usage:
#   ./scripts/local.sh              Start Orcha locally (seeds from ACA on first run)
#   ./scripts/local.sh --reset      Wipe local DB and re-seed from ACA
#   ./scripts/local.sh --stop       Stop the local instance
#   ./scripts/local.sh --pull       Download ACA DB via az cli (no mount needed)
#
# Prerequisites:
#   - Azure File Share mounted OR use --pull to download via az cli
#   - .env file with SESSION_SECRET=<same as ACA>
#
# Environment overrides:
#   LOCAL_PORT              Host port (default: 3001)
#   MAX_CONCURRENT_SESSIONS Max agent sessions (default: 3)
#   ACA_MOUNT_PATH          AFS mount path (default: Z:/ on Windows, /mnt/aca on Linux)
#   STORAGE_ACCOUNT         Azure storage account name (for --pull)

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

# ── Resolve storage account from parameters.json if not set ──────────────────
resolve_storage_account() {
  if [ -n "$STORAGE_ACCOUNT" ]; then
    return
  fi
  local params="$PROJECT_DIR/infra/parameters.json"
  if [ -f "$params" ]; then
    STORAGE_ACCOUNT=$(grep -o '"storageAccountName"[^,]*' "$params" | head -1 | sed 's/.*"value"[^"]*"//;s/".*//' | tr -d '[:space:]')
    # Try .parameters.X.value format (ARM template style)
    if [ -z "$STORAGE_ACCOUNT" ]; then
      STORAGE_ACCOUNT=$(python3 -c "import json,sys; p=json.load(open('$params')); print(p.get('parameters',p).get('storageAccountName',{}).get('value',''))" 2>/dev/null || echo "")
    fi
  fi
  if [ -z "$STORAGE_ACCOUNT" ]; then
    echo "ERROR: STORAGE_ACCOUNT not set and couldn't find it in infra/parameters.json"
    echo "  Set it: export STORAGE_ACCOUNT=<your-storage-account-name>"
    exit 1
  fi
}

# ── Pull DB from Azure ───────────────────────────────────────────────────────
pull_aca_db() {
  resolve_storage_account
  mkdir -p "$DATA_DIR"

  echo "    Downloading orcha.db from storage account: $STORAGE_ACCOUNT"
  local key
  key=$(az storage account keys list --account-name "$STORAGE_ACCOUNT" --query "[0].value" -o tsv)

  az storage file download \
    --share-name orcha-data \
    --path orcha.db \
    --dest "$DATA_DIR/orcha.db" \
    --account-name "$STORAGE_ACCOUNT" \
    --account-key "$key" \
    --no-progress \
    --output none

  echo "    Downloaded $(du -h "$DATA_DIR/orcha.db" | cut -f1) → $DATA_DIR/orcha.db"
}

# ── Scrub runtime tables from a downloaded DB ────────────────────────────────
scrub_db() {
  echo "    Scrubbing runtime tables..."
  node -e "
    const Database = (await import('better-sqlite3')).default;
    const db = new Database('$DATA_DIR/orcha.db');
    db.pragma('journal_mode = WAL');
    const tables = [
      'session_messages','channel_members','message_channels',
      'task_transcript','task_events','tasks',
      'session_credentials','status_events','sessions',
      'web_sessions','instances'
    ];
    for (const t of tables) {
      try { const r = db.prepare('DELETE FROM \"'+t+'\"').run(); if (r.changes) console.log('    cleared', t, '('+r.changes+' rows)'); } catch {}
    }
    const r = db.prepare(\"UPDATE repos SET status = 'pending', bare_path = NULL\").run();
    console.log('    reset', r.changes, 'repos to pending');
    db.close();
  "
}

# ── Check .env ───────────────────────────────────────────────────────────────
check_env() {
  if [ ! -f "$PROJECT_DIR/.env" ] && [ -z "$SESSION_SECRET" ]; then
    echo "ERROR: No .env file and SESSION_SECRET not set."
    echo ""
    echo "Create a .env file:"
    echo "  echo 'SESSION_SECRET=<your-aca-secret>' > .env"
    echo ""
    echo "Or get it from infra/parameters.json → sessionSecret"
    exit 1
  fi
}

# ── Start containers ─────────────────────────────────────────────────────────
start_orcha() {
  echo "==> Starting local Orcha..."
  docker compose -f "$COMPOSE_FILE" up --build -d
  echo ""
  echo "==> Orcha is starting at http://localhost:${LOCAL_PORT:-3001}"
  echo "    Logs:  bash scripts/local.sh --logs"
  echo "    Stop:  bash scripts/local.sh --stop"
  echo "    Reset: bash scripts/local.sh --reset"
  docker compose -f "$COMPOSE_FILE" logs -f
}

# ── Commands ─────────────────────────────────────────────────────────────────

case "${1:-start}" in
  --pull|-p)
    check_env
    echo "==> Pulling ACA config (no mount needed)..."
    pull_aca_db
    scrub_db
    echo "==> DB ready. Starting Orcha..."
    start_orcha
    ;;

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
    # If ACA mount available, seed will pick it up. Otherwise starts clean.
    start_orcha
    ;;

  --stop|-s)
    echo "==> Stopping local Orcha..."
    docker compose -f "$COMPOSE_FILE" down
    echo "    Stopped."
    ;;

  --logs|-l)
    docker compose -f "$COMPOSE_FILE" logs -f
    ;;

  start|"")
    check_env

    # Check mount is accessible
    if [ ! -d "$ACA_MOUNT_PATH" ] && [ ! -f "$DATA_DIR/orcha.db" ]; then
      echo "WARNING: ACA mount not found at $ACA_MOUNT_PATH and no local DB exists."
      echo ""
      echo "Options:"
      echo "  1. Mount Azure File Share and re-run"
      echo "  2. bash scripts/local.sh --pull    (downloads DB via az cli, no mount needed)"
      echo "  3. Continue without ACA config (start fresh)"
      echo ""
      read -rp "Continue fresh? [y/N] " confirm
      [[ "$confirm" =~ ^[Yy]$ ]] || exit 0
    fi

    start_orcha
    ;;

  *)
    echo "Usage: bash scripts/local.sh [command]"
    echo ""
    echo "Commands:"
    echo "  (no args)   Start Orcha locally (seeds from ACA mount on first run)"
    echo "  --pull      Download ACA DB via az cli and start (no mount needed)"
    echo "  --reset     Wipe local DB + repos, re-seed from ACA"
    echo "  --stop      Stop the local instance"
    echo "  --logs      Tail container logs"
    exit 1
    ;;
esac
