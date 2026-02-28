#!/usr/bin/env bash
# logs.sh — Stream or tail logs from the Orcha Azure Container App.
#
# Usage:
#   bash scripts/logs.sh              # tail last 50 lines
#   bash scripts/logs.sh --tail 100   # tail last N lines
#   bash scripts/logs.sh --follow     # stream live (ctrl-C to stop)
#   bash scripts/logs.sh --rg mygroup # override resource group (default: orcha)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PARAMS_FILE="${SCRIPT_DIR}/../infra/parameters.json"

TAIL=50
FOLLOW=false
RESOURCE_GROUP="orcha"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tail)   TAIL="$2";           shift 2 ;;
    --follow) FOLLOW=true;         shift   ;;
    --rg)     RESOURCE_GROUP="$2"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

read_param() {
  python3 -c "
import json
with open('${PARAMS_FILE}') as f:
    p = json.load(f)
print(p['parameters']['$1']['value'])
"
}

CONTAINER_APP_NAME=$(read_param containerAppName)

command -v az >/dev/null 2>&1 || { echo "az CLI not found." >&2; exit 1; }
az account show --output none 2>/dev/null || { echo "Not logged in to Azure. Run: az login" >&2; exit 1; }

echo "=== Orcha logs: ${CONTAINER_APP_NAME} (rg: ${RESOURCE_GROUP}) ==="
echo ""

if [[ "${FOLLOW}" == "true" ]]; then
  az containerapp logs show \
    --name "${CONTAINER_APP_NAME}" \
    --resource-group "${RESOURCE_GROUP}" \
    --container orcha \
    --follow \
    --format text
else
  az containerapp logs show \
    --name "${CONTAINER_APP_NAME}" \
    --resource-group "${RESOURCE_GROUP}" \
    --container orcha \
    --tail "${TAIL}" \
    --format text
fi
