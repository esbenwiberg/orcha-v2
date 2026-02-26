# Deployment Guide

This guide walks through deploying Orcha to Azure Container Apps from scratch.

## Prerequisites

- [Azure CLI](https://learn.microsoft.com/en-us/cli/azure/install-azure-cli) `>= 2.50`
- [Bicep CLI](https://learn.microsoft.com/en-us/azure/azure-resource-manager/bicep/install) (installed via `az bicep install`)
- [Docker](https://docs.docker.com/get-docker/) `>= 24`
- An active Azure subscription

Verify the tools are available:

```bash
az --version
az bicep version
docker --version
```

## Step 1 — Log in to Azure

```bash
az login
az account set --subscription "<your-subscription-id>"
```

## Step 2 — Create a resource group

```bash
az group create --name rg-orcha --location eastus
```

## Step 3 — Create an Azure Container Registry

Pick a globally unique name (lowercase alphanumeric, 5–50 chars). Replace
`<acrName>` with your chosen name throughout this guide.

```bash
az acr create \
  --name <acrName> \
  --resource-group rg-orcha \
  --sku Basic \
  --admin-enabled false
```

## Step 4 — Build and push images

Log in to the registry, then build and push both container images.

```bash
ACR_LOGIN_SERVER=$(az acr show --name <acrName> --query loginServer -o tsv)
az acr login --name <acrName>

# Build and push the orcha Express server image
docker build -t "${ACR_LOGIN_SERVER}/orcha:latest" .
docker push "${ACR_LOGIN_SERVER}/orcha:latest"

# Build and push the Caddy sidecar image
docker build -t "${ACR_LOGIN_SERVER}/orcha-caddy:latest" ./caddy
docker push "${ACR_LOGIN_SERVER}/orcha-caddy:latest"
```

To tag with a specific version instead of `latest`, replace `latest` with a
git SHA or semver string and set the same value for `imageTag` in the
parameters file.

## Step 5 — Prepare the parameters file

Copy the example file and fill in all placeholder values:

```bash
cp infra/parameters.example.json infra/parameters.json
```

Edit `infra/parameters.json`:

| Parameter | Description |
|---|---|
| `storageAccountName` | Globally unique, 3–24 lowercase alphanumeric (e.g. `orchadata8f3a`). |
| `environmentName` | Name for the Container Apps environment (e.g. `orcha-env`). |
| `containerAppName` | Name for the Container App (e.g. `orcha`). |
| `acrName` | The ACR name chosen in Step 3 (without `.azurecr.io`). |
| `imageTag` | Image tag to deploy (e.g. `latest` or an 8-char git SHA). |
| `orchaToken` | A strong random secret used to authenticate API requests. Generate one with `openssl rand -hex 32`. |
| `orchaDomain` | The public FQDN you will point at the app (e.g. `orcha.example.com`). |
| `acmeEmail` | Email address for Let's Encrypt renewal notifications. |

Do not commit `infra/parameters.json` — it contains the `orchaToken` secret.
Add it to `.gitignore` if necessary.

## Step 6 — Deploy the Bicep templates

```bash
az deployment group create \
  --resource-group rg-orcha \
  --template-file infra/main.bicep \
  --parameters @infra/parameters.json
```

The deployment provisions (in order):

1. Azure Storage Account with a `bare-repos` blob container and an
   `orcha-data` file share (5 GiB).
2. Container Apps managed environment with the file share attached as a
   named storage item.
3. User-assigned managed identity with `AcrPull` role on the ACR.
4. Container App running the `orcha` and `caddy` containers with the
   persistent `/data` volume mount.

## Step 7 — Retrieve the application URL

```bash
az deployment group show \
  --resource-group rg-orcha \
  --name main \
  --query properties.outputs.containerAppFqdn.value \
  -o tsv
```

The FQDN returned is the Container Apps-assigned hostname. Point your DNS
`A` or `CNAME` record for `orchaDomain` at this hostname so Let's Encrypt
can issue a certificate.

You can also look up the URL directly:

```bash
az containerapp show \
  --name orcha \
  --resource-group rg-orcha \
  --query properties.configuration.ingress.fqdn \
  -o tsv
```

## Step 8 — Rotate the ORCHA_TOKEN

To rotate the API token without a full redeployment, update the secret value
and create a new revision:

```bash
# Update the secret
az containerapp secret set \
  --name orcha \
  --resource-group rg-orcha \
  --secrets "orcha-token=<new-token>"

# Force a new revision to pick up the updated secret
az containerapp update \
  --name orcha \
  --resource-group rg-orcha \
  --revision-suffix "$(date +%Y%m%d%H%M%S)"
```

The old revision drains and the new revision starts with the updated token.
Old tokens are immediately invalid once the old revision is deactivated.

## GitHub Actions Setup

The CI/CD workflows in `.github/workflows/` use OIDC (federated credentials)
to authenticate with Azure — no long-lived client secrets are stored in
GitHub.

### Required repository secrets

| Secret | Description |
|---|---|
| `ACR_NAME` | ACR name (without `.azurecr.io`). |
| `AZURE_CLIENT_ID` | Client ID of the Entra ID app registration used for OIDC. |
| `AZURE_TENANT_ID` | Entra ID tenant ID. |
| `AZURE_SUBSCRIPTION_ID` | Azure subscription ID. |
| `AZURE_RESOURCE_GROUP` | Resource group name (e.g. `rg-orcha`). |
| `CONTAINER_APP_NAME` | Container App name (e.g. `orcha`). |
| `ORCHA_DOMAIN` | Public FQDN used in the health check gate. |

### Configuring the OIDC federated credential

1. Create an app registration in Entra ID (or use an existing service
   principal).
2. Add a **Federated credential** of type *GitHub Actions* scoped to your
   repository and the `main` branch (or the environment you use).
3. Grant the service principal the following roles on the resource group:
   - `Contributor` (to deploy resources)
   - `User Access Administrator` (to assign the `AcrPull` role)
4. Copy the **Client ID**, **Tenant ID**, and **Subscription ID** into the
   GitHub repository secrets listed above.

With these secrets in place, the `push-images.yml` workflow builds and pushes
images on every successful CI run on `main`, and `cd.yml` deploys the new
revision and gates on a `/health` HTTP check.
