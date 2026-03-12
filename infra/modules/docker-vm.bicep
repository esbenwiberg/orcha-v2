// docker-vm.bicep — Remote Docker VM for validation on ACA
//
// Standalone module deployed via scripts/deploy-docker-vm.sh.
// NOT wired into main.bicep — ACA has no VNet, so this VM gets a
// public IP secured by NSG + mutual TLS on port 2376.
//
// Usage:
//   az deployment group create \
//     --template-file infra/modules/docker-vm.bicep \
//     --parameters vmName=orcha-docker adminUsername=orcha sshPublicKey='ssh-rsa ...'

targetScope = 'resourceGroup'

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

@description('Name for the VM and related resources.')
param vmName string = 'orcha-docker'

@description('Azure region. Defaults to the resource group location.')
param location string = resourceGroup().location

@description('VM size. B1s (1 vCPU, 1 GB) for starters, B2s (2 vCPU, 4 GB) if you need more headroom.')
@allowed(['Standard_B1s', 'Standard_B2s', 'Standard_B2ms'])
param vmSize string = 'Standard_B1s'

@description('Admin username for SSH access.')
param adminUsername string = 'orcha'

@description('SSH public key for the admin user.')
param sshPublicKey string

@description('Cloud-init config (base64-encoded). Installs Docker CE.')
param cloudInitBase64 string

@description('Source IP ranges allowed to reach Docker TLS (port 2376). Defaults to any — mutual TLS is the auth boundary.')
param dockerAllowedSourceIPs array = ['*']

@description('Source IP ranges allowed to SSH (port 22). Restrict to your IP for production.')
param sshAllowedSourceIPs array = ['*']

// ---------------------------------------------------------------------------
// Network Security Group
// ---------------------------------------------------------------------------
resource nsg 'Microsoft.Network/networkSecurityGroups@2023-05-01' = {
  name: '${vmName}-nsg'
  location: location
  properties: {
    securityRules: [
      {
        name: 'AllowSSH'
        properties: {
          priority: 100
          direction: 'Inbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourcePortRange: '*'
          destinationPortRange: '22'
          sourceAddressPrefixes: sshAllowedSourceIPs
          destinationAddressPrefix: '*'
        }
      }
      {
        name: 'AllowDockerTLS'
        properties: {
          priority: 110
          direction: 'Inbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourcePortRange: '*'
          destinationPortRange: '2376'
          sourceAddressPrefixes: dockerAllowedSourceIPs
          destinationAddressPrefix: '*'
        }
      }
      {
        // Validation containers publish ephemeral ports (30000-39999).
        // ACA's Playwright connects to these to reach the app under test.
        name: 'AllowValidationPorts'
        properties: {
          priority: 120
          direction: 'Inbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourcePortRange: '*'
          destinationPortRange: '30000-39999'
          sourceAddressPrefixes: dockerAllowedSourceIPs
          destinationAddressPrefix: '*'
        }
      }
    ]
  }
}

// ---------------------------------------------------------------------------
// Public IP
// ---------------------------------------------------------------------------
resource publicIP 'Microsoft.Network/publicIPAddresses@2023-05-01' = {
  name: '${vmName}-pip'
  location: location
  sku: { name: 'Standard' }
  properties: {
    publicIPAllocationMethod: 'Static'
    publicIPAddressVersion: 'IPv4'
  }
}

// ---------------------------------------------------------------------------
// Virtual Network + Subnet
// ---------------------------------------------------------------------------
resource vnet 'Microsoft.Network/virtualNetworks@2023-05-01' = {
  name: '${vmName}-vnet'
  location: location
  properties: {
    addressSpace: { addressPrefixes: ['10.200.0.0/24'] }
    subnets: [
      {
        name: 'docker-subnet'
        properties: {
          addressPrefix: '10.200.0.0/24'
          networkSecurityGroup: { id: nsg.id }
        }
      }
    ]
  }
}

// ---------------------------------------------------------------------------
// Network Interface
// ---------------------------------------------------------------------------
resource nic 'Microsoft.Network/networkInterfaces@2023-05-01' = {
  name: '${vmName}-nic'
  location: location
  properties: {
    ipConfigurations: [
      {
        name: 'ipconfig1'
        properties: {
          privateIPAllocationMethod: 'Dynamic'
          publicIPAddress: { id: publicIP.id }
          subnet: { id: vnet.properties.subnets[0].id }
        }
      }
    ]
  }
}

// ---------------------------------------------------------------------------
// Virtual Machine
// ---------------------------------------------------------------------------
resource vm 'Microsoft.Compute/virtualMachines@2023-07-01' = {
  name: vmName
  location: location
  properties: {
    hardwareProfile: { vmSize: vmSize }
    osProfile: {
      computerName: vmName
      adminUsername: adminUsername
      linuxConfiguration: {
        disablePasswordAuthentication: true
        ssh: {
          publicKeys: [
            {
              path: '/home/${adminUsername}/.ssh/authorized_keys'
              keyData: sshPublicKey
            }
          ]
        }
      }
      customData: cloudInitBase64
    }
    storageProfile: {
      imageReference: {
        publisher: 'Canonical'
        offer: '0001-com-ubuntu-server-jammy'
        sku: '22_04-lts-gen2'
        version: 'latest'
      }
      osDisk: {
        createOption: 'FromImage'
        managedDisk: { storageAccountType: 'Standard_LRS' }
        diskSizeGB: 30
      }
    }
    networkProfile: {
      networkInterfaces: [{ id: nic.id }]
    }
  }
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

@description('Public IP address of the Docker VM.')
output vmPublicIP string = publicIP.properties.ipAddress

@description('VM resource ID.')
output vmId string = vm.id

@description('Admin username for SSH.')
output adminUser string = adminUsername

@description('DOCKER_HOST value to set on ACA.')
output dockerHost string = 'tcp://${publicIP.properties.ipAddress}:2376'
