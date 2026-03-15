#!/usr/bin/env bash
# deploy-app.sh — Build images, push to ACR, run DB migrations, deploy to Azure Container Apps.
#
# Usage:
#   ./scripts/deploy-app.sh [--params infra/parameters.json] [--tag <git-sha|version>]
#
# What it does:
#   1. Builds the orcha and orcha-caddy Docker images
#   2. Pushes both to Azure Container Registry
#   3. Updates the Container App to the new image tag
#   4. Polls until the new revision is provisioned
#   5. Runs a health check (which verifies DB connectivity)
#
# DB migrations run automatically on startup via runMigrations() in start-server.ts —
# no separate migration step is needed here.
#
# Env vars:
#   GITHUB_PAT  — (optional) GitHub PAT for private repos when using ACR Tasks git source
#
# Requires: az CLI >= 2.50, Docker >= 24 (or ACR Tasks if Docker is unavailable)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# ── Defaults ──────────────────────────────────────────────────────────────────
PARAMS_FILE="${REPO_ROOT}/infra/parameters.json"
TAG=""
RESOURCE_GROUP="orcha"

# ── Arg parsing ───────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --params) PARAMS_FILE="$2"; shift 2 ;;
    --tag)    TAG="$2";         shift 2 ;;
    --rg)     RESOURCE_GROUP="$2"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

# ── Helpers ───────────────────────────────────────────────────────────────────
info()  { echo "  $*"; }
ok()    { echo "✓ $*"; }
die()   { echo "✗ $*" >&2; exit 1; }

echo ""
echo "=== Orcha app deployment ==="
echo ""

# ── Pre-flight checks ─────────────────────────────────────────────────────────
command -v az     >/dev/null 2>&1 || die "az CLI not found."
USE_ACR_BUILD=false
if ! command -v docker >/dev/null 2>&1; then
  info "Docker not found — will use ACR Tasks (az acr build) for remote builds."
  USE_ACR_BUILD=true
elif ! docker info >/dev/null 2>&1; then
  info "Docker not reachable (socket permission?) — will use ACR Tasks for remote builds."
  USE_ACR_BUILD=true
fi

[[ -f "${PARAMS_FILE}" ]] || die "Parameters file not found: ${PARAMS_FILE}
  Copy the example and fill in your values:
    cp infra/parameters.example.json infra/parameters.json"

# ── Read params ───────────────────────────────────────────────────────────────
read_param() {
  python3 -c "
import json
with open('${PARAMS_FILE}') as f:
    p = json.load(f)
print(p['parameters']['$1']['value'])
"
}

ACR_NAME=$(read_param acrName)
CONTAINER_APP_NAME=$(read_param containerAppName)
ORCHA_DOMAIN=$(read_param orchaDomain 2>/dev/null || echo "")
STORAGE_ACCOUNT=$(read_param storageAccountName 2>/dev/null || echo "")

# ── Image tag: default to short git SHA ───────────────────────────────────────
if [[ -z "${TAG}" ]]; then
  TAG=$(git -C "${REPO_ROOT}" rev-parse --short=8 HEAD 2>/dev/null || echo "latest")
fi
info "Image tag: ${TAG}"

# ── Azure login check ─────────────────────────────────────────────────────────
info "Checking Azure login..."
az account show --output none 2>/dev/null || die "Not logged in to Azure. Run: az login"
ok "Azure login confirmed"

# ── Set subscription ─────────────────────────────────────────────────────────
info "Setting subscription to Projectum_Playground..."
az account set --subscription "Projectum_Playground"
ok "Subscription: Projectum_Playground"

# ── ACR login ─────────────────────────────────────────────────────────────────
ACR_SERVER=$(az acr show --name "${ACR_NAME}" --query loginServer -o tsv)

if [[ "${USE_ACR_BUILD}" == "false" ]]; then
  info "Logging in to ACR '${ACR_NAME}'..."
  az acr login --name "${ACR_NAME}"
  ok "ACR login: ${ACR_SERVER}"
fi

# ── Resolve git source URL for ACR Tasks ─────────────────────────────────────
# ACR Tasks can clone directly from a git URL, avoiding the need to tar+upload
# the entire local directory. This prevents OOM in memory-constrained containers.
ACR_GIT_SOURCE=""
if [[ "${USE_ACR_BUILD}" == "true" ]]; then
  GIT_REMOTE=$(git -C "${REPO_ROOT}" remote get-url origin 2>/dev/null || echo "")
  if [[ -n "${GIT_REMOTE}" ]]; then
    # Convert SSH to HTTPS: git@github.com:org/repo.git → https://github.com/org/repo.git
    if [[ "${GIT_REMOTE}" == git@* ]]; then
      GIT_REMOTE=$(echo "${GIT_REMOTE}" | sed 's|git@\([^:]*\):\(.*\)|https://\1/\2|')
    fi
    GIT_BRANCH=$(git -C "${REPO_ROOT}" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "main")
    # Embed PAT for private repos if available
    if [[ -n "${GITHUB_PAT:-}" ]]; then
      ACR_GIT_SOURCE=$(echo "${GIT_REMOTE}" | sed "s|https://|https://${GITHUB_PAT}@|")
    else
      ACR_GIT_SOURCE="${GIT_REMOTE}"
    fi
    ACR_GIT_SOURCE="${ACR_GIT_SOURCE}#${GIT_BRANCH}"
    info "ACR Tasks source: git (${GIT_BRANCH})"
  else
    info "No git remote found — falling back to local context upload"
  fi
fi

# ── Build and push images ─────────────────────────────────────────────────────
echo ""
if [[ "${USE_ACR_BUILD}" == "true" ]]; then
  if [[ -n "${ACR_GIT_SOURCE}" ]]; then
    # ACR clones from git — no local context upload (memory-safe)
    info "Building orcha image via ACR Tasks (git source)..."
    az acr build \
      --registry "${ACR_NAME}" \
      --image "orcha:${TAG}" \
      --image "orcha:latest" \
      --build-arg "COMMIT_SHA=${TAG}" \
      "${ACR_GIT_SOURCE}"
    ok "orcha image built and pushed (${TAG})"

    echo ""
    info "Building orcha-caddy image via ACR Tasks (git source)..."
    az acr build \
      --registry "${ACR_NAME}" \
      --image "orcha-caddy:${TAG}" \
      --image "orcha-caddy:latest" \
      "${ACR_GIT_SOURCE}:caddy"
    ok "orcha-caddy image built and pushed (${TAG})"
  else
    # Fallback: upload local context (requires enough memory to tar the repo)
    info "Building orcha image via ACR Tasks (local context)..."
    az acr build \
      --registry "${ACR_NAME}" \
      --image "orcha:${TAG}" \
      --image "orcha:latest" \
      --build-arg "COMMIT_SHA=${TAG}" \
      "${REPO_ROOT}"
    ok "orcha image built and pushed (${TAG})"

    echo ""
    info "Building orcha-caddy image via ACR Tasks (local context)..."
    az acr build \
      --registry "${ACR_NAME}" \
      --image "orcha-caddy:${TAG}" \
      --image "orcha-caddy:latest" \
      "${REPO_ROOT}/caddy"
    ok "orcha-caddy image built and pushed (${TAG})"
  fi
else
  # Local Docker build + push
  info "Building orcha image..."
  DOCKER_BUILDKIT=1 docker build \
    --build-arg "COMMIT_SHA=${TAG}" \
    -t "${ACR_SERVER}/orcha:${TAG}" \
    -t "${ACR_SERVER}/orcha:latest" \
    "${REPO_ROOT}"
  ok "orcha image built"

  info "Pushing orcha image..."
  docker push "${ACR_SERVER}/orcha:${TAG}"
  docker push "${ACR_SERVER}/orcha:latest"
  ok "orcha image pushed (${TAG})"

  echo ""
  info "Building orcha-caddy image..."
  DOCKER_BUILDKIT=1 docker build \
    -t "${ACR_SERVER}/orcha-caddy:${TAG}" \
    -t "${ACR_SERVER}/orcha-caddy:latest" \
    "${REPO_ROOT}/caddy"
  ok "orcha-caddy image built"

  info "Pushing orcha-caddy image..."
  docker push "${ACR_SERVER}/orcha-caddy:${TAG}"
  docker push "${ACR_SERVER}/orcha-caddy:latest"
  ok "orcha-caddy image pushed (${TAG})"
fi

# ── Pre-deploy Azure File Share snapshot ──────────────────────────────────────
# Create a point-in-time snapshot of the data share BEFORE deploying. This
# captures the DB, bare repos, and all persistent state. If the deploy goes
# wrong or the container OOM-kills before syncing, we can restore from here.
if [[ -n "${STORAGE_ACCOUNT}" ]]; then
  echo ""
  info "Creating Azure File Share snapshot (pre-deploy safety net)..."
  SNAP_TIME=$(az storage share snapshot \
    --name orcha-data \
    --account-name "${STORAGE_ACCOUNT}" \
    --query "snapshot" \
    -o tsv 2>/dev/null || echo "")
  if [[ -n "${SNAP_TIME}" ]]; then
    ok "File share snapshot created: ${SNAP_TIME}"
  else
    info "Snapshot creation failed (non-fatal) — continuing deploy"
  fi
else
  info "Skipping file share snapshot (storageAccountName not in params)"
fi

# ── Snapshot current revision ─────────────────────────────────────────────────
OLD_REVISION=$(az containerapp revision list \
  --name "${CONTAINER_APP_NAME}" \
  --resource-group "${RESOURCE_GROUP}" \
  --query "sort_by(@, &properties.createdTime) | [-1].name" \
  -o tsv 2>/dev/null || echo "")

# ── Update Container App (both containers) ───────────────────────────────────
echo ""
info "Updating orcha container to tag '${TAG}'..."
az containerapp update \
  --name "${CONTAINER_APP_NAME}" \
  --resource-group "${RESOURCE_GROUP}" \
  --container-name orcha \
  --image "${ACR_SERVER}/orcha:${TAG}" \
  --output none

info "Updating caddy container to tag '${TAG}'..."
az containerapp update \
  --name "${CONTAINER_APP_NAME}" \
  --resource-group "${RESOURCE_GROUP}" \
  --container-name caddy \
  --image "${ACR_SERVER}/orcha-caddy:${TAG}" \
  --output none
ok "Container App update triggered (orcha + caddy)"

# ── Poll revision state ───────────────────────────────────────────────────────
info "Waiting for new revision to become active..."
ATTEMPTS=0
MAX_ATTEMPTS=20
while [[ ${ATTEMPTS} -lt ${MAX_ATTEMPTS} ]]; do
  LATEST=$(az containerapp revision list \
    --name "${CONTAINER_APP_NAME}" \
    --resource-group "${RESOURCE_GROUP}" \
    --query "sort_by(@, &properties.createdTime) | [-1].{name:name, state:properties.provisioningState}" \
    -o json 2>/dev/null || echo "{}")

  REV_NAME=$(echo "${LATEST}" | python3 -c "import json,sys; print(json.load(sys.stdin).get('name',''))" 2>/dev/null || echo "")
  STATE=$(echo "${LATEST}" | python3 -c "import json,sys; print(json.load(sys.stdin).get('state',''))" 2>/dev/null || echo "unknown")

  # Only consider it done when a NEW revision (not the old one) reaches a terminal state
  if [[ "${REV_NAME}" != "${OLD_REVISION}" ]]; then
    if [[ "${STATE}" == "Provisioned" ]]; then
      ok "Revision '${REV_NAME}' provisioned"
      break
    elif [[ "${STATE}" == "Failed" ]]; then
      die "Revision '${REV_NAME}' provisioning failed. Check Container Apps logs in the Azure portal."
    fi
  fi

  ATTEMPTS=$((ATTEMPTS + 1))
  info "State: ${STATE} (rev: ${REV_NAME:-pending}) — waiting 15s... (${ATTEMPTS}/${MAX_ATTEMPTS})"
  sleep 15
done

if [[ ${ATTEMPTS} -ge ${MAX_ATTEMPTS} ]]; then
  die "Timed out waiting for revision to provision."
fi

# ── Health check ──────────────────────────────────────────────────────────────
# DB migrations run automatically on startup, so a successful /health response
# confirms both the app is up and the database is reachable.
echo ""
if [[ -n "${ORCHA_DOMAIN}" && "${ORCHA_DOMAIN}" != "orcha.example.com" ]]; then
  HEALTH_URL="https://${ORCHA_DOMAIN}/health"
  info "Running health check: ${HEALTH_URL}"
  RESPONSE=$(curl --silent --retry 6 --retry-delay 5 --retry-connrefused \
    --max-time 10 --fail "${HEALTH_URL}" 2>/dev/null || echo "")

  if [[ -n "${RESPONSE}" ]]; then
    STATUS=$(echo "${RESPONSE}" | python3 -c "import json,sys; print(json.load(sys.stdin).get('status',''))" 2>/dev/null || echo "")
    if [[ "${STATUS}" == "ok" ]]; then
      ok "Health check passed — app is live and DB is reachable"
    else
      die "Health check returned unexpected status: ${RESPONSE}"
    fi
  else
    die "Health check failed — app did not respond at ${HEALTH_URL}"
  fi
else
  info "Skipping health check (orchaDomain not set or is placeholder)"
fi

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
ok "Deployment complete — tag: ${TAG}"
if [[ -n "${ORCHA_DOMAIN}" && "${ORCHA_DOMAIN}" != "orcha.example.com" ]]; then
  echo "  https://${ORCHA_DOMAIN}"
fi
echo ""
