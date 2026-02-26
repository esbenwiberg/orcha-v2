@description('Azure region for all resources.')
param location string

@description('Name for the Container Apps managed environment.')
param environmentName string

@description('Name of the storage account that backs the file share.')
param storageAccountName string

@description('Primary key of the storage account.')
@secure()
param storageAccountKey string

@description('Name of the Azure File Share to mount.')
param fileShareName string

@description('Name used to reference the file share storage item within the environment.')
param storageItemName string = 'orcha-data-storage'

// ---------------------------------------------------------------------------
// Container Apps managed environment
// ---------------------------------------------------------------------------
resource containerEnv 'Microsoft.App/managedEnvironments@2023-05-01' = {
  name: environmentName
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'azure-monitor'
    }
  }
}

// ---------------------------------------------------------------------------
// Attach the Azure File Share as a named storage item in the environment so
// that container apps in this environment can reference it by storageItemName.
// ---------------------------------------------------------------------------
resource envStorage 'Microsoft.App/managedEnvironments/storages@2023-05-01' = {
  parent: containerEnv
  name: storageItemName
  properties: {
    azureFile: {
      accountName: storageAccountName
      accountKey: storageAccountKey
      shareName: fileShareName
      accessMode: 'ReadWrite'
    }
  }
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------
output environmentId string = containerEnv.id

output storageItemName string = envStorage.name
