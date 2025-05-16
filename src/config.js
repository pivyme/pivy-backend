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
}