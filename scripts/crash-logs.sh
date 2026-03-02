#!/usr/bin/env bash
# crash-logs.sh — Query Log Analytics for container crash/restart events.
#
# Usage:
#   bash scripts/crash-logs.sh              # last 50 entries, 24h window
#   bash scripts/crash-logs.sh --hours 72   # last 72 hours
#   bash scripts/crash-logs.sh --take 100   # last 100 entries
#   bash scripts/crash-logs.sh --system     # system events (OOM, restarts)

set -euo pipefail

HOURS=24
TAKE=50
SYSTEM=false
WORKSPACE="orcha-logs"
APP_NAME="orcha"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --hours)     HOURS="$2";     shift 2 ;;
    --take)      TAKE="$2";      shift 2 ;;
    --system)    SYSTEM=true;    shift   ;;
    --workspace) WORKSPACE="$2"; shift 2 ;;
    --app)       APP_NAME="$2";  shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

command -v az >/dev/null 2>&1 || { echo "az CLI not found." >&2; exit 1; }
az account show --output none 2>/dev/null || { echo "Not logged in to Azure. Run: az login" >&2; exit 1; }

if [[ "${SYSTEM}" == "true" ]]; then
  echo "=== System events (restarts, OOM, crashes) — last ${HOURS}h ==="
  echo ""
  az monitor log-analytics query \
    --workspace "${WORKSPACE}" \
    --analytics-query "
ContainerAppSystemLogs_CL
| where ContainerAppName_s == '${APP_NAME}'
| where TimeGenerated > ago(${HOURS}h)
| where Reason_s in ('BackOff', 'OOMKilled', 'CrashLoopBackOff', 'ContainerStarted', 'ContainerCreated', 'Killing')
    or Log_s has_any ('OOM', 'kill', 'crash', 'restart', 'exit')
| project TimeGenerated, Reason_s, Type_s, Log_s
| order by TimeGenerated desc
| take ${TAKE}
" \
    -o table
else
  echo "=== Console logs — last ${HOURS}h ==="
  echo ""
  az monitor log-analytics query \
    --workspace "${WORKSPACE}" \
    --analytics-query "
ContainerAppConsoleLogs_CL
| where ContainerAppName_s == '${APP_NAME}'
| where TimeGenerated > ago(${HOURS}h)
| order by TimeGenerated desc
| take ${TAKE}
" \
    -o table
fi
