export const CHAINS = {
  MAINNET: {
    id: 'MAINNET',
    rpcUrl: process.env.SOLANA_RPC_MAINNET,
    heliusRpcUrl: process.env.HELIUS_RPC_MAINNET,
    pivyStealthProgramId: process.env.PIVY_STEALTH_PROGRAM_ADDRESS_MAINNET,
  },
  DEVNET: {
    id: 'DEVNET',
    rpcUrl: process.env.SOLANA_RPC_DEVNET,
    heliusRpcUrl: process.env.HELIUS_RPC_DEVNET,
    pivyStealthProgramId: process.env.PIVY_STEALTH_PROGRAM_ADDRESS_DEVNET,
  },
  SUI_MAINNET: {
    id: 'SUI_MAINNET',
    rpcUrl: process.env.SUI_RPC_MAINNET,
    publicRpcUrl: 'https://fullnode.mainnet.sui.io:443',
    pivyStealthProgramId: process.env.PIVY_STEALTH_PROGRAM_ID_SUI_MAINNET,
    blockvisionApiEndpoint: process.env.SUI_BLOCKVISION_API_MAINNET_ENDPOINT
  },
  SUI_TESTNET: {
    id: 'SUI_TESTNET',
    rpcUrl: process.env.SUI_RPC_TESTNET,
    publicRpcUrl: 'https://fullnode.testnet.sui.io:443',
    pivyStealthProgramId: process.env.PIVY_STEALTH_PROGRAM_ID_SUI_TESTNET,
    blockvisionApiEndpoint: process.env.SUI_BLOCKVISION_API_TESTNET_ENDPOINT
  },
}

export const isTestnet = process.env.CHAIN === 'DEVNET';

export const WALLET_CHAINS = {
  SOLANA: {
    id: 'SOLANA',
    name: 'Solana',
  },
  SUI: {
    id: 'SUI',
    name: 'Sui',
  },
}
