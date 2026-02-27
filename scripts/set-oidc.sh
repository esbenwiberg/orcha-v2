#!/usr/bin/env bash
# set-oidc.sh — Switch Orcha to OIDC (Entra ID) authentication.
#
# Usage:
#   ./scripts/set-oidc.sh
#
# You will be prompted for:
#   - Entra ID Tenant ID
#   - App Registration Client ID
#   - App Registration Client Secret

set -euo pipefail

RESOURCE_GROUP="${ORCHA_RG:-orcha}"
CONTAINER_APP="${ORCHA_APP:-orcha}"

echo ""
echo "=== Configure OIDC authentication for Orcha ==="
echo ""

read -rp "  Entra ID Tenant ID: " TENANT_ID
read -rp "  Client ID (Application ID): " CLIENT_ID
read -rsp "  Client Secret: " CLIENT_SECRET
echo ""

DISCOVERY_URL="https://login.microsoftonline.com/${TENANT_ID}/v2.0/.well-known/openid-configuration"

FQDN=$(az containerapp show \
  --name "${CONTAINER_APP}" \
  --resource-group "${RESOURCE_GROUP}" \
  --query properties.configuration.ingress.fqdn \
  -o tsv)

REDIRECT_URI="https://${FQDN}/auth/callback"
SESSION_SECRET=$(openssl rand -hex 32)

echo ""
echo "  Discovery URL : ${DISCOVERY_URL}"
echo "  Redirect URI  : ${REDIRECT_URI}"
echo ""
echo "  Make sure '${REDIRECT_URI}' is registered as a"
echo "  redirect URI in your Entra ID app registration."
echo ""
read -rp "  Press Enter to apply, or Ctrl-C to cancel..."

echo ""
echo "  Updating secrets..."
az containerapp secret set \
  --name "${CONTAINER_APP}" \
  --resource-group "${RESOURCE_GROUP}" \
  --secrets \
    "oidc-client-id=${CLIENT_ID}" \
    "oidc-client-secret=${CLIENT_SECRET}" \
    "session-secret=${SESSION_SECRET}" \
  --output none

echo "  Updating environment variables..."
az containerapp update \
  --name "${CONTAINER_APP}" \
  --resource-group "${RESOURCE_GROUP}" \
  --container-name orcha \
  --set-env-vars \
    "AUTH_MODE=oidc" \
    "OIDC_CLIENT_ID=secretref:oidc-client-id" \
    "OIDC_CLIENT_SECRET=secretref:oidc-client-secret" \
    "OIDC_DISCOVERY_URL=${DISCOVERY_URL}" \
    "OIDC_REDIRECT_URI=${REDIRECT_URI}" \
    "SESSION_SECRET=secretref:session-secret" \
  --revision-suffix "oidc-$(date +%H%M%S)" \
  --output none

echo ""
echo "✓ OIDC authentication enabled"
echo "  App URL: https://${FQDN}"
echo ""
