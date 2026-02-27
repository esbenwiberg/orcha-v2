// Orcha — Azure Container Apps deployment
// Provisions: Storage Account + File Share, Container Apps Environment,
// User-Assigned Managed Identity, AcrPull role assignment, and the
// Container App with orcha + caddy containers.

targetScope = 'resourceGroup'

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

@description('Azure region for all resources. Defaults to the resource group location.')
param location string = resourceGroup().location

@description('Globally unique name for the storage account (3-24 lowercase alphanumeric).')
param storageAccountName string

@description('Name for the Container Apps managed environment.')
param environmentName string

@description('Name for the Container App.')
param containerAppName string

@description('Name of the Azure Container Registry (without .azurecr.io suffix).')
param acrName string

@description('Image tag to deploy.')
param imageTag string = 'latest'

@description('Bearer token used by the Orcha API for token-based auth.')
@secure()
param orchaToken string

@description('Public FQDN that Caddy will serve and obtain a Let\'s Encrypt certificate for.')
param orchaDomain string

@description('Email address passed to Let\'s Encrypt for renewal notifications.')
param acmeEmail string

@description('Secret used to sign Express session cookies. Must be stable across restarts.')
@secure()
param sessionSecret string

@description('Use ACR admin credentials instead of managed identity for image pull. Set to true when you lack Microsoft.Authorization/roleAssignments/write permission.')
param useAcrAdmin bool = false

// ---------------------------------------------------------------------------
// Reference the existing ACR
// ---------------------------------------------------------------------------
resource acr 'Microsoft.ContainerRegistry/registries@2023-01-01-preview' existing = {
  name: acrName
}

// ---------------------------------------------------------------------------
// User-assigned managed identity (used for ACR pull — skipped when useAcrAdmin)
// ---------------------------------------------------------------------------
resource orchaIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = if (!useAcrAdmin) {
  name: 'orcha-identity'
  location: location
}

// AcrPull built-in role definition ID
var acrPullRoleId = '7f951dda-4ed3-4680-a7ca-43fe172d538d'

resource acrPullAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!useAcrAdmin) {
  // Role assignment name must be a stable GUID derived from the principal and
  // role to avoid duplicate assignments on re-deploy.
  name: guid(acr.id, orchaIdentity.id, acrPullRoleId)
  scope: acr
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', acrPullRoleId)
    principalId: orchaIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

// ---------------------------------------------------------------------------
// Storage module
// ---------------------------------------------------------------------------
module storage 'modules/storage.bicep' = {
  name: 'storage-deploy'
  params: {
    location: location
    storageAccountName: storageAccountName
  }
}

// ---------------------------------------------------------------------------
// Container Apps environment module
// ---------------------------------------------------------------------------
module containerEnv 'modules/container-env.bicep' = {
  name: 'container-env-deploy'
  params: {
    location: location
    environmentName: environmentName
    storageAccountName: storage.outputs.storageAccountName
    storageAccountKey: storage.outputs.storageAccountKey
    fileShareName: storage.outputs.fileShareName
  }
}

// ---------------------------------------------------------------------------
// Container App module
// ---------------------------------------------------------------------------
module containerApp 'modules/container-app.bicep' = {
  name: 'container-app-deploy'
  params: {
    location: location
    containerAppName: containerAppName
    environmentId: containerEnv.outputs.environmentId
    storageItemName: containerEnv.outputs.storageItemName
    acrLoginServer: '${acrName}.azurecr.io'
    imageTag: imageTag
    orchaToken: orchaToken
    sessionSecret: sessionSecret
    orchaDomain: orchaDomain
    acmeEmail: acmeEmail
    useAcrAdmin: useAcrAdmin
    managedIdentityId: useAcrAdmin ? '' : orchaIdentity.id
    managedIdentityClientId: useAcrAdmin ? '' : orchaIdentity.properties.clientId
    acrAdminUsername: useAcrAdmin ? acr.listCredentials().username : ''
    acrAdminPassword: useAcrAdmin ? acr.listCredentials().passwords[0].value : ''
  }
  dependsOn: useAcrAdmin ? [containerEnv] : [containerEnv, acrPullAssignment]
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------
output containerAppFqdn string = containerApp.outputs.containerAppFqdn
