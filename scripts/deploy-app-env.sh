#!/usr/bin/env bash
# deploy-app-env.sh — Deploy Orcha using environment variables (no parameters.json needed).
#
# Designed to be called from Orcha's repo Deploy button. All config comes from
# env vars set in the repo's Deploy Env Vars settings.
#
# Required env vars:
#   ORCHA_ACR_NAME          — Azure Container Registry name
#   ORCHA_CONTAINER_APP     — Container App name
#
# Optional env vars:
#   ORCHA_RESOURCE_GROUP    — Resource group (default: "orcha")
#   ORCHA_SUBSCRIPTION      — Azure subscription ID (uses current default if unset)
#   ORCHA_DOMAIN            — Domain for health check (skipped if unset)
#   ORCHA_TAG               — Image tag (default: short git SHA)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# ── Helpers ───────────────────────────────────────────────────────────────────
info()  { echo "  $*"; }
ok()    { echo "✓ $*"; }
die()   { echo "✗ $*" >&2; exit 1; }

echo ""
echo "=== Orcha deploy (env-based) ==="
echo ""

# ── Validate required env vars ───────────────────────────────────────────────
[[ -n "${ORCHA_ACR_NAME:-}" ]]      || die "ORCHA_ACR_NAME is not set"
[[ -n "${ORCHA_CONTAINER_APP:-}" ]] || die "ORCHA_CONTAINER_APP is not set"

ACR_NAME="${ORCHA_ACR_NAME}"
CONTAINER_APP_NAME="${ORCHA_CONTAINER_APP}"
RESOURCE_GROUP="${ORCHA_RESOURCE_GROUP:-orcha}"
SUB_FLAG=( ${ORCHA_SUBSCRIPTION:+--subscription "${ORCHA_SUBSCRIPTION}"} )
ORCHA_DOMAIN="${ORCHA_DOMAIN:-}"

# ── Image tag ────────────────────────────────────────────────────────────────
TAG="${ORCHA_TAG:-$(git -C "${REPO_ROOT}" rev-parse --short=8 HEAD 2>/dev/null || echo "latest")}"
info "Image tag: ${TAG}"

# ── Pre-flight ───────────────────────────────────────────────────────────────
command -v az >/dev/null 2>&1 || die "az CLI not found"
info "Checking Azure login..."
az account show --output none 2>/dev/null || die "Not logged in to Azure. Run: az login"
if [[ -n "${ORCHA_SUBSCRIPTION:-}" ]]; then
  ok "Azure login confirmed — subscription: ${ORCHA_SUBSCRIPTION}"
else
  ok "Azure login confirmed — using default subscription"
fi

ACR_SERVER=$(az acr show --name "${ACR_NAME}" "${SUB_FLAG[@]}" --query loginServer -o tsv)

# ── Build via ACR Tasks (remote — no Docker needed) ─────────────────────────
echo ""
info "Building orcha image via ACR Tasks..."
az acr build \
  --registry "${ACR_NAME}" \
  "${SUB_FLAG[@]}" \
  --image "orcha:${TAG}" \
  --image "orcha:latest" \
  "${REPO_ROOT}"
ok "orcha image built and pushed (${TAG})"

echo ""
info "Building orcha-caddy image via ACR Tasks..."
az acr build \
  --registry "${ACR_NAME}" \
  "${SUB_FLAG[@]}" \
  --image "orcha-caddy:${TAG}" \
  --image "orcha-caddy:latest" \
  "${REPO_ROOT}/caddy"
ok "orcha-caddy image built and pushed (${TAG})"

# ── Snapshot current revision ─────────────────────────────────────────────────
OLD_REVISION=$(az containerapp revision list \
  --name "${CONTAINER_APP_NAME}" \
  --resource-group "${RESOURCE_GROUP}" \
  "${SUB_FLAG[@]}" \
  --query "[0].name" \
  -o tsv 2>/dev/null || echo "")

# ── Update Container App (both containers) ───────────────────────────────────
echo ""
info "Updating orcha container to tag '${TAG}'..."
az containerapp update \
  --name "${CONTAINER_APP_NAME}" \
  --resource-group "${RESOURCE_GROUP}" \
  "${SUB_FLAG[@]}" \
  --container-name orcha \
  --image "${ACR_SERVER}/orcha:${TAG}" \
  --output none

info "Updating caddy container to tag '${TAG}'..."
az containerapp update \
  --name "${CONTAINER_APP_NAME}" \
  --resource-group "${RESOURCE_GROUP}" \
  "${SUB_FLAG[@]}" \
  --container-name caddy \
  --image "${ACR_SERVER}/orcha-caddy:${TAG}" \
  --output none
ok "Container App update triggered (orcha + caddy)"

# ── Poll revision ────────────────────────────────────────────────────────────
info "Waiting for new revision..."
ATTEMPTS=0
MAX_ATTEMPTS=20
while [[ ${ATTEMPTS} -lt ${MAX_ATTEMPTS} ]]; do
  LATEST=$(az containerapp revision list \
    --name "${CONTAINER_APP_NAME}" \
    --resource-group "${RESOURCE_GROUP}" \
    "${SUB_FLAG[@]}" \
    --query "[0].{name:name, state:properties.provisioningState}" \
    -o json 2>/dev/null || echo "{}")

  REV_NAME=$(echo "${LATEST}" | python3 -c "import json,sys; print(json.load(sys.stdin).get('name',''))" 2>/dev/null || echo "")
  STATE=$(echo "${LATEST}" | python3 -c "import json,sys; print(json.load(sys.stdin).get('state',''))" 2>/dev/null || echo "unknown")

  # Only consider it done when a NEW revision (not the old one) reaches a terminal state
  if [[ "${REV_NAME}" != "${OLD_REVISION}" ]]; then
    if [[ "${STATE}" == "Provisioned" ]]; then
      ok "Revision '${REV_NAME}' provisioned"
      break
    elif [[ "${STATE}" == "Failed" ]]; then
      die "Revision '${REV_NAME}' provisioning failed"
    fi
  fi

  ATTEMPTS=$((ATTEMPTS + 1))
  info "State: ${STATE} (rev: ${REV_NAME:-pending}) — waiting 15s... (${ATTEMPTS}/${MAX_ATTEMPTS})"
  sleep 15
done

[[ ${ATTEMPTS} -lt ${MAX_ATTEMPTS} ]] || die "Timed out waiting for revision"

# ── Health check ─────────────────────────────────────────────────────────────
echo ""
if [[ -n "${ORCHA_DOMAIN}" ]]; then
  HEALTH_URL="https://${ORCHA_DOMAIN}/health"
  info "Health check: ${HEALTH_URL}"
  RESPONSE=$(curl --silent --retry 6 --retry-delay 5 --retry-connrefused \
    --max-time 10 --fail "${HEALTH_URL}" 2>/dev/null || echo "")

  if [[ -n "${RESPONSE}" ]]; then
    STATUS=$(echo "${RESPONSE}" | python3 -c "import json,sys; print(json.load(sys.stdin).get('status',''))" 2>/dev/null || echo "")
    if [[ "${STATUS}" == "ok" ]]; then
      ok "Health check passed"
    else
      die "Health check returned: ${RESPONSE}"
    fi
  else
    die "Health check failed — no response from ${HEALTH_URL}"
  fi
else
  info "Skipping health check (ORCHA_DOMAIN not set)"
fi

# ── Done ─────────────────────────────────────────────────────────────────────
echo ""
ok "Deployment complete — tag: ${TAG}"
[[ -n "${ORCHA_DOMAIN}" ]] && echo "  https://${ORCHA_DOMAIN}"
echo ""
