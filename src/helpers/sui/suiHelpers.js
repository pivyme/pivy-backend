import { formatUnits } from "ethers";
import { getOrCreateSuiTokenCache } from "../../utils/suiUtils.js";

/**
 * Gets the portfolio information for a SUI wallet address
 * @param {string} address - The SUI wallet address to get portfolio information for
 * @param {string} chainId - The chain ID (SUI_MAINNET or SUI_DEVNET)
 * @param {import("@mysten/sui/client").SuiClient} suiClient - The SUI client instance for making RPC calls
 * @returns {Promise<Object>}
 */
export const getSuiPortfolio = async (address, chainId, suiClient) => {
  const balances = await suiClient.getAllBalances({
    owner: address
  })

  console.log('balances', balances)

  // Initialize native balance with default values
  let nativeBalance = {
    mint: "0x2::sui::SUI",
    name: "SUI",
    symbol: "SUI",
    decimals: 9,
    imageUrl: 'https://assets.coingecko.com/coins/images/26375/standard/sui-ocean-square.png?1727791290',
    amount: 0,
  }

  let tokenBalance = []
  for (const balance of balances) {
    const tokenInfo = await getOrCreateSuiTokenCache(balance.coinType, chainId)
    console.log('tokenInfo', tokenInfo)

    const uiAmount = parseFloat(formatUnits(balance.totalBalance, tokenInfo.decimals))

    // If it's the native SUI token, update the native balance
    if (balance.coinType === "0x2::sui::SUI") {
      nativeBalance.amount = uiAmount
      continue // Skip adding to tokenBalance
    }

    // Add non-native tokens to tokenBalance
    tokenBalance.push({
      mint: balance.coinType,
      owner: address,
      tokenAmount: uiAmount,
      token: {
        name: tokenInfo.name,
        symbol: tokenInfo.symbol,
        decimals: tokenInfo.decimals,
        imageUrl: tokenInfo.imageUrl,
        description: tokenInfo.description,
      }
    })
  }

  console.log('Portfolio data:', { nativeBalance, tokenBalance })

  return {
    nativeBalance,
    tokenBalance
  };
}