@description('Azure region for all resources.')
param location string

@description('Globally unique name for the storage account (3-24 lowercase alphanumeric).')
param storageAccountName string

// ---------------------------------------------------------------------------
// Storage account
// ---------------------------------------------------------------------------
resource storageAccount 'Microsoft.Storage/storageAccounts@2023-01-01' = {
  name: storageAccountName
  location: location
  kind: 'StorageV2'
  sku: {
    name: 'Standard_LRS'
  }
  properties: {
    allowBlobPublicAccess: false
    supportsHttpsTrafficOnly: true
    minimumTlsVersion: 'TLS1_2'
  }
}

// ---------------------------------------------------------------------------
// Blob service (required parent for blob containers)
// ---------------------------------------------------------------------------
resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-01-01' = {
  parent: storageAccount
  name: 'default'
}

// ---------------------------------------------------------------------------
// Blob container — git bare repositories
// ---------------------------------------------------------------------------
resource bareReposContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-01-01' = {
  parent: blobService
  name: 'bare-repos'
  properties: {
    publicAccess: 'None'
  }
}

// ---------------------------------------------------------------------------
// File service (required parent for file shares)
// ---------------------------------------------------------------------------
resource fileService 'Microsoft.Storage/storageAccounts/fileServices@2023-01-01' = {
  parent: storageAccount
  name: 'default'
}

// ---------------------------------------------------------------------------
// File share — /data persistent mount (5 GiB)
// ---------------------------------------------------------------------------
resource orchaDataShare 'Microsoft.Storage/storageAccounts/fileServices/shares@2023-01-01' = {
  parent: fileService
  name: 'orcha-data'
  properties: {
    shareQuota: 5
  }
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------
output storageAccountName string = storageAccount.name

output fileShareName string = orchaDataShare.name

@description('Primary storage account key — treat as a secret.')
@secure()
output storageAccountKey string = storageAccount.listKeys().keys[0].value
