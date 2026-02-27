#!/usr/bin/env bash
# deploy-infra.sh — Provision Azure resources for Orcha (idempotent).
#
# Usage:
#   ./scripts/deploy-infra.sh [--params infra/parameters.json] [--location eastus]
#
# Requires: az CLI >= 2.50, Bicep CLI (az bicep install)
# Run once to stand up infrastructure; safe to re-run for updates.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# ── Defaults ─────────────────────────────────────────────────────────────────
PARAMS_FILE="${REPO_ROOT}/infra/parameters.json"
LOCATION="eastus"
RESOURCE_GROUP="rg-orcha"

# ── Arg parsing ───────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --params)   PARAMS_FILE="$2"; shift 2 ;;
    --location) LOCATION="$2";    shift 2 ;;
    --rg)       RESOURCE_GROUP="$2"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

# ── Helpers ───────────────────────────────────────────────────────────────────
info()  { echo "  $*"; }
ok()    { echo "✓ $*"; }
die()   { echo "✗ $*" >&2; exit 1; }

echo ""
echo "=== Orcha infrastructure deployment ==="
echo ""

# ── Pre-flight checks ─────────────────────────────────────────────────────────
command -v az    >/dev/null 2>&1 || die "az CLI not found. Install: https://docs.microsoft.com/cli/azure/install-azure-cli"
az bicep version >/dev/null 2>&1 || { info "Installing Bicep CLI..."; az bicep install; }

[[ -f "${PARAMS_FILE}" ]] || die "Parameters file not found: ${PARAMS_FILE}
  Copy the example and fill in your values:
    cp infra/parameters.example.json infra/parameters.json"

# Check for unfilled placeholders
if grep -q 'REPLACE_ME\|<unique>\|example\.com' "${PARAMS_FILE}"; then
  die "Parameters file contains placeholder values. Edit ${PARAMS_FILE} before deploying."
fi

# ── Azure login check ─────────────────────────────────────────────────────────
info "Checking Azure login..."
ACCOUNT_NAME=$(az account show --query 'name' -o tsv 2>/dev/null) \
  || die "Not logged in to Azure. Run: az login"
SUBSCRIPTION_ID=$(az account show --query 'id' -o tsv)
ok "Logged in — subscription: ${ACCOUNT_NAME} (${SUBSCRIPTION_ID})"

# ── Resource group ────────────────────────────────────────────────────────────
# Some subscriptions require an Owner-Created-By tag.  Set OWNER_TAG to your
# alias to include it, or leave unset to skip.
OWNER_TAG="${OWNER_TAG:-}"

info "Ensuring resource group '${RESOURCE_GROUP}' exists in ${LOCATION}..."
RG_ARGS=(--name "${RESOURCE_GROUP}" --location "${LOCATION}" --output none)
if [[ -n "${OWNER_TAG}" ]]; then
  RG_ARGS+=(--tags "Owner-Created-By=${OWNER_TAG}")
fi
az group create "${RG_ARGS[@]}"
ok "Resource group ready"

# ── Read a parameter from the params file ─────────────────────────────────────
read_param() {
  python3 -c "
import json
with open('${PARAMS_FILE}') as f:
    p = json.load(f)
print(p['parameters']['$1']['value'])
"
}

# ── Ensure ACR exists (idempotent) ────────────────────────────────────────────
ACR_NAME=$(read_param acrName 2>/dev/null || echo "")
USE_ACR_ADMIN=$(read_param useAcrAdmin 2>/dev/null || echo "false")
# Normalise boolean: Python prints True/False, params may use true/false
USE_ACR_ADMIN=$(echo "${USE_ACR_ADMIN}" | tr '[:upper:]' '[:lower:]')

if [[ -n "${ACR_NAME}" ]]; then
  ADMIN_FLAG="false"
  if [[ "${USE_ACR_ADMIN}" == "true" ]]; then
    ADMIN_FLAG="true"
  fi

  if ! az acr show --name "${ACR_NAME}" --resource-group "${RESOURCE_GROUP}" --output none 2>/dev/null; then
    info "Creating Azure Container Registry '${ACR_NAME}' (admin=${ADMIN_FLAG})..."
    az acr create \
      --name "${ACR_NAME}" \
      --resource-group "${RESOURCE_GROUP}" \
      --sku Basic \
      --admin-enabled "${ADMIN_FLAG}" \
      --output none
    ok "ACR '${ACR_NAME}' created"
  else
    # Ensure admin flag matches desired state on existing ACR
    if [[ "${ADMIN_FLAG}" == "true" ]]; then
      az acr update --name "${ACR_NAME}" --resource-group "${RESOURCE_GROUP}" \
        --admin-enabled true --output none 2>/dev/null || true
    fi
    ok "ACR '${ACR_NAME}' already exists"
  fi
fi

# ── Deploy Bicep ──────────────────────────────────────────────────────────────
echo ""
info "Deploying Bicep templates (this may take 3-5 minutes)..."
az deployment group create \
  --resource-group "${RESOURCE_GROUP}" \
  --template-file "${REPO_ROOT}/infra/main.bicep" \
  --parameters "@${PARAMS_FILE}" \
  --output json | tee /tmp/orcha-deploy-output.json | python3 -c "
import json, sys
data = json.load(sys.stdin)
state = data.get('properties', {}).get('provisioningState', 'unknown')
print(f'  Provisioning state: {state}')
outputs = data.get('properties', {}).get('outputs', {})
fqdn = outputs.get('containerAppFqdn', {}).get('value', '')
if fqdn:
    print(f'  Container App FQDN: {fqdn}')
" 2>/dev/null || true

echo ""
ok "Infrastructure deployment complete"

# ── Show FQDN ─────────────────────────────────────────────────────────────────
CONTAINER_APP_NAME=$(python3 -c "
import json, sys
with open('${PARAMS_FILE}') as f:
    p = json.load(f)
print(p['parameters']['containerAppName']['value'])
" 2>/dev/null || echo "orcha")

FQDN=$(az containerapp show \
  --name "${CONTAINER_APP_NAME}" \
  --resource-group "${RESOURCE_GROUP}" \
  --query properties.configuration.ingress.fqdn \
  -o tsv 2>/dev/null || echo "")

if [[ -n "${FQDN}" ]]; then
  echo ""
  echo "  App URL: https://${FQDN}"
  echo "  Point your DNS CNAME for orchaDomain at: ${FQDN}"
fi

echo ""
