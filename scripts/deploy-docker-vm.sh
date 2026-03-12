#!/usr/bin/env bash
# deploy-docker-vm.sh — Provision a remote Docker VM for Orcha validation.
#
# This is an ADDON script — it deploys independently of main infra.
# Safe to run on top of an existing Orcha deployment.
#
# What it does:
#   1. Deploys the docker-vm.bicep module (VM + NSG + NIC + public IP)
#   2. Waits for cloud-init to install Docker CE
#   3. Generates mutual TLS certificates (CA + server + client)
#   4. Uploads server certs to the VM and configures dockerd for TLS
#   5. Copies client certs to Azure File Share (/data/docker-tls/)
#   6. Sets DOCKER_HOST, DOCKER_TLS_VERIFY, DOCKER_CERT_PATH on the Container App
#
# Usage:
#   ./scripts/deploy-docker-vm.sh [--rg orcha] [--vm-name orcha-docker] [--vm-size Standard_B1s]
#
# Prerequisites:
#   - az CLI >= 2.50
#   - openssl
#   - ssh-keygen
#   - An existing Orcha deployment (Container App + Storage Account)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# ── Defaults ─────────────────────────────────────────────────────────────────
RESOURCE_GROUP="orcha"
VM_NAME="orcha-docker"
VM_SIZE="Standard_B1s"
ADMIN_USER="orcha"
PARAMS_FILE="${REPO_ROOT}/infra/parameters.json"
CERT_DIR=""  # Generated temp dir

# ── Arg parsing ──────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --rg)       RESOURCE_GROUP="$2"; shift 2 ;;
    --vm-name)  VM_NAME="$2";       shift 2 ;;
    --vm-size)  VM_SIZE="$2";       shift 2 ;;
    --params)   PARAMS_FILE="$2";   shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

# ── Helpers ──────────────────────────────────────────────────────────────────
info()  { echo "  $*"; }
ok()    { echo "✓ $*"; }
warn()  { echo "⚠ $*"; }
die()   { echo "✗ $*" >&2; exit 1; }

cleanup() {
  if [[ -n "${CERT_DIR}" && -d "${CERT_DIR}" ]]; then
    info "Cleaning up temporary cert directory..."
    rm -rf "${CERT_DIR}"
  fi
}
trap cleanup EXIT

read_param() {
  python3 -c "
import json
with open('${PARAMS_FILE}') as f:
    p = json.load(f)
print(p['parameters']['$1']['value'])
" 2>/dev/null
}

echo ""
echo "=== Orcha Docker VM deployment ==="
echo ""

# ── Pre-flight checks ────────────────────────────────────────────────────────
command -v az       >/dev/null 2>&1 || die "az CLI not found"
command -v openssl  >/dev/null 2>&1 || die "openssl not found"
command -v ssh      >/dev/null 2>&1 || die "ssh not found"
command -v scp      >/dev/null 2>&1 || die "scp not found"

[[ -f "${PARAMS_FILE}" ]] || die "Parameters file not found: ${PARAMS_FILE}"

info "Checking Azure login..."
ACCOUNT_NAME=$(az account show --query 'name' -o tsv 2>/dev/null) \
  || die "Not logged in to Azure. Run: az login"
ok "Logged in — subscription: ${ACCOUNT_NAME}"

# Read params we'll need later
CONTAINER_APP_NAME=$(read_param containerAppName 2>/dev/null || echo "orcha")
STORAGE_ACCOUNT=$(read_param storageAccountName 2>/dev/null || echo "")

[[ -n "${STORAGE_ACCOUNT}" ]] || die "storageAccountName not found in parameters file"

# ── SSH key ──────────────────────────────────────────────────────────────────
SSH_KEY_PATH="${HOME}/.ssh/orcha-docker-vm"
if [[ ! -f "${SSH_KEY_PATH}" ]]; then
  info "Generating SSH key pair at ${SSH_KEY_PATH}..."
  ssh-keygen -t ed25519 -f "${SSH_KEY_PATH}" -N "" -C "orcha-docker-vm" >/dev/null
  ok "SSH key generated"
else
  ok "SSH key already exists at ${SSH_KEY_PATH}"
fi
SSH_PUBLIC_KEY=$(cat "${SSH_KEY_PATH}.pub")

# ── Deploy Bicep ─────────────────────────────────────────────────────────────
echo ""
info "Deploying Docker VM (${VM_SIZE}) — this may take 2-3 minutes..."

CLOUD_INIT_B64=$(base64 -w0 "${REPO_ROOT}/infra/cloud-init-docker.yml" 2>/dev/null \
  || base64 -i "${REPO_ROOT}/infra/cloud-init-docker.yml")  # macOS compat

DEPLOY_OUTPUT=$(az deployment group create \
  --resource-group "${RESOURCE_GROUP}" \
  --template-file "${REPO_ROOT}/infra/modules/docker-vm.bicep" \
  --parameters \
    vmName="${VM_NAME}" \
    vmSize="${VM_SIZE}" \
    adminUsername="${ADMIN_USER}" \
    sshPublicKey="${SSH_PUBLIC_KEY}" \
    cloudInitBase64="${CLOUD_INIT_B64}" \
  --output json)

VM_IP=$(echo "${DEPLOY_OUTPUT}" | python3 -c "
import json, sys
data = json.load(sys.stdin)
print(data['properties']['outputs']['vmPublicIP']['value'])
")
DOCKER_HOST_VAL=$(echo "${DEPLOY_OUTPUT}" | python3 -c "
import json, sys
data = json.load(sys.stdin)
print(data['properties']['outputs']['dockerHost']['value'])
")

ok "VM deployed — IP: ${VM_IP}"
echo "  DOCKER_HOST: ${DOCKER_HOST_VAL}"

# ── Wait for cloud-init ──────────────────────────────────────────────────────
echo ""
info "Waiting for cloud-init to complete (Docker CE install)..."

SSH_OPTS="-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=10 -o LogLevel=ERROR -i ${SSH_KEY_PATH}"
MAX_ATTEMPTS=40  # 40 × 15s = 10 min max
for i in $(seq 1 ${MAX_ATTEMPTS}); do
  if ssh ${SSH_OPTS} "${ADMIN_USER}@${VM_IP}" "test -f /var/lib/cloud/instance/boot-finished-docker" 2>/dev/null; then
    ok "Cloud-init complete"
    break
  fi
  if [[ $i -eq ${MAX_ATTEMPTS} ]]; then
    die "Cloud-init did not complete within 10 minutes. SSH in and check: ssh -i ${SSH_KEY_PATH} ${ADMIN_USER}@${VM_IP}"
  fi
  echo -n "."
  sleep 15
done

# Verify Docker is running
ssh ${SSH_OPTS} "${ADMIN_USER}@${VM_IP}" "docker --version" >/dev/null 2>&1 \
  || die "Docker not found on VM after cloud-init"
DOCKER_VERSION=$(ssh ${SSH_OPTS} "${ADMIN_USER}@${VM_IP}" "docker --version")
ok "Docker on VM: ${DOCKER_VERSION}"

# ── Generate TLS certificates ────────────────────────────────────────────────
echo ""
info "Generating TLS certificates..."
CERT_DIR=$(mktemp -d -t orcha-docker-tls-XXXXXX)

# CA key + cert
openssl genrsa -out "${CERT_DIR}/ca-key.pem" 4096 2>/dev/null
openssl req -new -x509 -days 3650 -key "${CERT_DIR}/ca-key.pem" \
  -sha256 -out "${CERT_DIR}/ca.pem" \
  -subj "/CN=Orcha Docker CA" 2>/dev/null

# Server key + cert (signed by CA, valid for the VM IP)
openssl genrsa -out "${CERT_DIR}/server-key.pem" 4096 2>/dev/null
openssl req -new -key "${CERT_DIR}/server-key.pem" \
  -subj "/CN=${VM_IP}" \
  -out "${CERT_DIR}/server.csr" 2>/dev/null

cat > "${CERT_DIR}/server-ext.cnf" <<EOF
subjectAltName = IP:${VM_IP},IP:127.0.0.1
extendedKeyUsage = serverAuth
EOF

openssl x509 -req -days 3650 \
  -in "${CERT_DIR}/server.csr" \
  -CA "${CERT_DIR}/ca.pem" -CAkey "${CERT_DIR}/ca-key.pem" -CAcreateserial \
  -extfile "${CERT_DIR}/server-ext.cnf" \
  -out "${CERT_DIR}/server-cert.pem" 2>/dev/null

# Client key + cert (signed by CA — Orcha uses this to authenticate)
openssl genrsa -out "${CERT_DIR}/key.pem" 4096 2>/dev/null
openssl req -new -key "${CERT_DIR}/key.pem" \
  -subj "/CN=orcha-client" \
  -out "${CERT_DIR}/client.csr" 2>/dev/null

cat > "${CERT_DIR}/client-ext.cnf" <<EOF
extendedKeyUsage = clientAuth
EOF

openssl x509 -req -days 3650 \
  -in "${CERT_DIR}/client.csr" \
  -CA "${CERT_DIR}/ca.pem" -CAkey "${CERT_DIR}/ca-key.pem" -CAcreateserial \
  -extfile "${CERT_DIR}/client-ext.cnf" \
  -out "${CERT_DIR}/cert.pem" 2>/dev/null

ok "TLS certificates generated (10 year validity)"

# ── Upload server certs to VM ────────────────────────────────────────────────
echo ""
info "Uploading server certificates to VM..."

scp ${SSH_OPTS} \
  "${CERT_DIR}/ca.pem" \
  "${CERT_DIR}/server-cert.pem" \
  "${CERT_DIR}/server-key.pem" \
  "${ADMIN_USER}@${VM_IP}:/tmp/"

# Move certs into place and configure dockerd for TLS
ssh ${SSH_OPTS} "${ADMIN_USER}@${VM_IP}" bash <<'REMOTE_SCRIPT'
set -euo pipefail

sudo mv /tmp/ca.pem /tmp/server-cert.pem /tmp/server-key.pem /etc/docker/tls/
sudo chmod 600 /etc/docker/tls/server-key.pem
sudo chmod 644 /etc/docker/tls/ca.pem /etc/docker/tls/server-cert.pem

# Configure dockerd to listen on TLS port 2376 (in addition to unix socket)
sudo mkdir -p /etc/docker
sudo tee /etc/docker/daemon.json > /dev/null <<'DAEMON_JSON'
{
  "hosts": ["unix:///var/run/docker.sock", "tcp://0.0.0.0:2376"],
  "tls": true,
  "tlsverify": true,
  "tlscacert": "/etc/docker/tls/ca.pem",
  "tlscert": "/etc/docker/tls/server-cert.pem",
  "tlskey": "/etc/docker/tls/server-key.pem",
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "10m",
    "max-file": "3"
  }
}
DAEMON_JSON

# Docker systemd unit uses -H fd:// by default which conflicts with daemon.json hosts.
# Override to remove the -H flag.
sudo mkdir -p /etc/systemd/system/docker.service.d
sudo tee /etc/systemd/system/docker.service.d/override.conf > /dev/null <<'OVERRIDE'
[Service]
ExecStart=
ExecStart=/usr/bin/dockerd --containerd=/run/containerd/containerd.sock
OVERRIDE

sudo systemctl daemon-reload
sudo systemctl restart docker

# Verify TLS is working
sleep 2
sudo docker info > /dev/null 2>&1
echo "Docker restarted with TLS on :2376"
REMOTE_SCRIPT

ok "Docker daemon configured with mutual TLS"

# ── Upload client certs to Azure File Share ──────────────────────────────────
echo ""
info "Uploading client certificates to Azure File Share..."

STORAGE_KEY=$(az storage account keys list \
  --account-name "${STORAGE_ACCOUNT}" \
  --resource-group "${RESOURCE_GROUP}" \
  --query '[0].value' -o tsv)

# Upload client certs (ca.pem, cert.pem, key.pem) to the file share
for CERT_FILE in ca.pem cert.pem key.pem; do
  az storage file upload \
    --account-name "${STORAGE_ACCOUNT}" \
    --account-key "${STORAGE_KEY}" \
    --share-name "orcha-data" \
    --source "${CERT_DIR}/${CERT_FILE}" \
    --path "docker-tls/${CERT_FILE}" \
    --output none 2>/dev/null
done

ok "Client certs uploaded to Azure File Share (orcha-data/docker-tls/)"

# ── Set env vars on Container App ────────────────────────────────────────────
echo ""
info "Configuring Container App with Docker VM connection..."

az containerapp update \
  --name "${CONTAINER_APP_NAME}" \
  --resource-group "${RESOURCE_GROUP}" \
  --set-env-vars \
    "DOCKER_HOST=${DOCKER_HOST_VAL}" \
    "DOCKER_TLS_VERIFY=1" \
    "DOCKER_CERT_PATH=/data/docker-tls" \
    "DOCKER_VM_IP=${VM_IP}" \
  --output none

ok "Container App updated with DOCKER_HOST=${DOCKER_HOST_VAL}"

# ── Verify connectivity ─────────────────────────────────────────────────────
echo ""
info "Verifying TLS connectivity from local machine..."

DOCKER_HOST="${DOCKER_HOST_VAL}" \
DOCKER_TLS_VERIFY=1 \
DOCKER_CERT_PATH="${CERT_DIR}" \
  docker info --format '{{.ServerVersion}}' 2>/dev/null \
  && ok "Remote Docker connection verified" \
  || warn "Could not verify — docker CLI may not be installed locally. The Container App should work fine."

# ── Done ─────────────────────────────────────────────────────────────────────
echo ""
echo "=== Docker VM deployment complete ==="
echo ""
echo "  VM IP:           ${VM_IP}"
echo "  DOCKER_HOST:     ${DOCKER_HOST_VAL}"
echo "  SSH:             ssh -i ${SSH_KEY_PATH} ${ADMIN_USER}@${VM_IP}"
echo "  Client certs:    /data/docker-tls/ (on Azure File Share)"
echo ""
echo "  The Container App will use the remote Docker VM for validation"
echo "  on next restart. To test immediately:"
echo "    az containerapp revision restart -n ${CONTAINER_APP_NAME} -g ${RESOURCE_GROUP} --revision \$(az containerapp revision list -n ${CONTAINER_APP_NAME} -g ${RESOURCE_GROUP} --query '[0].name' -o tsv)"
echo ""
