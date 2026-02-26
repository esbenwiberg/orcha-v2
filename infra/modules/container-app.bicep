@description('Azure region for all resources.')
param location string

@description('Name for the Container App.')
param containerAppName string

@description('Resource ID of the Container Apps managed environment.')
param environmentId string

@description('Name of the storage item defined in the managed environment.')
param storageItemName string

@description('Login server hostname of the Azure Container Registry (e.g. myacr.azurecr.io).')
param acrLoginServer string

@description('Image tag to deploy for both containers.')
param imageTag string = 'latest'

@description('Bearer token used by the Orcha API for token-based auth.')
@secure()
param orchaToken string

@description('Public FQDN that Caddy will serve and obtain a Let\'s Encrypt certificate for.')
param orchaDomain string

@description('Email address passed to Let\'s Encrypt for renewal notifications.')
param acmeEmail string

@description('Resource ID of the user-assigned managed identity used for ACR pull.')
param managedIdentityId string

@description('Client ID of the user-assigned managed identity.')
param managedIdentityClientId string

// ---------------------------------------------------------------------------
// Container App
// ---------------------------------------------------------------------------
resource containerApp 'Microsoft.App/containerApps@2023-05-01' = {
  name: containerAppName
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${managedIdentityId}': {}
    }
  }
  properties: {
    environmentId: environmentId
    configuration: {
      // ACR registry — authenticate with managed identity (no password secret needed)
      registries: [
        {
          server: acrLoginServer
          identity: managedIdentityId
        }
      ]
      // Caddy terminates TLS on port 443; expose it externally
      ingress: {
        external: true
        targetPort: 443
        transport: 'http'
      }
      secrets: [
        {
          name: 'orcha-token'
          value: orchaToken
        }
      ]
    }
    template: {
      // Persistent volume backed by the Azure File Share
      volumes: [
        {
          name: 'data-vol'
          storageType: 'AzureFile'
          storageName: storageItemName
        }
      ]
      containers: [
        // ------------------------------------------------------------------
        // Container 1: orcha — Express API server
        // ------------------------------------------------------------------
        {
          name: 'orcha'
          image: '${acrLoginServer}/orcha:${imageTag}'
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          env: [
            {
              name: 'ORCHA_DATA_DIR'
              value: '/data'
            }
            {
              name: 'AUTH_MODE'
              value: 'token'
            }
            {
              name: 'ORCHA_TOKEN'
              secretRef: 'orcha-token'
            }
          ]
          volumeMounts: [
            {
              volumeName: 'data-vol'
              mountPath: '/data'
            }
          ]
        }
        // ------------------------------------------------------------------
        // Container 2: caddy — TLS termination sidecar
        // ------------------------------------------------------------------
        {
          name: 'caddy'
          image: '${acrLoginServer}/orcha-caddy:${imageTag}'
          resources: {
            cpu: json('0.25')
            memory: '256Mi'
          }
          env: [
            {
              name: 'ORCHA_DOMAIN'
              value: orchaDomain
            }
            {
              name: 'ACME_EMAIL'
              value: acmeEmail
            }
          ]
          // Mount same volume so Caddy can persist certs at /data/caddy
          volumeMounts: [
            {
              volumeName: 'data-vol'
              mountPath: '/data'
            }
          ]
        }
      ]
    }
  }
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------
output containerAppFqdn string = containerApp.properties.configuration.ingress.fqdn
