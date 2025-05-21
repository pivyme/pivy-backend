import { SuiClient } from "@mysten/sui/client";
import { CHAINS } from "../config.js";
import { prismaQuery } from "../lib/prisma.js";

/**
 * Get or create token cache for SUI tokens
 * @param {string} coinType - The coin type (e.g., "0x2::sui::SUI")
 * @param {string} chainId - The chain ID (SUI_MAINNET or SUI_DEVNET)
 * @returns {Promise<Object>}
 */
export const getOrCreateSuiTokenCache = async (coinType, chainId) => {
  try {
    const existingCache = await prismaQuery.mintDataCache.findUnique({
      where: {
        mintAddress_chain: {
          mintAddress: coinType,
          chain: chainId
        }
      }
    })

    if (existingCache && !existingCache.isInvalid) {
      return existingCache;
    }

    const chain = CHAINS[chainId]
    if (!chain) {
      throw new Error(`Invalid chainId: ${chainId}`)
    }

    const suiClient = new SuiClient({
      url: chain.publicRpcUrl
    })

    console.log('Getting token info for coinType: ', coinType)

    // Get coin metadata
    const metadata = await suiClient.getCoinMetadata({ coinType });
    console.log('metadata', metadata)

    const cacheData = {
      mintAddress: coinType,
      chain: chainId,
      name: metadata?.name || coinType.split("::").pop() || "UNKNOWN",
      symbol: metadata?.symbol || coinType.split("::").pop() || "UNKNOWN",
      decimals: metadata?.decimals || 6,
      imageUrl: metadata?.iconUrl || null,
      description: metadata?.description || `Token at ${coinType}`,
      uriData: null,
      isInvalid: false
    }

    let priceUsd;
    // if symbol contain USD, EUR, GBP, or USDT, then set priceUsd to 1
    if (cacheData.symbol.includes("USD") || cacheData.symbol.includes("EUR") || cacheData.symbol.includes("GBP") || cacheData.symbol.includes("USDT")) {
      priceUsd = 1;
    } else {
      // get price from dexscreener
      priceUsd = 0
    }

    cacheData.priceUsd = priceUsd;

    await prismaQuery.mintDataCache.upsert({
      where: {
        mintAddress_chain: {
          mintAddress: coinType,
          chain: chainId
        }
      },
      update: cacheData,
      create: cacheData
    })

    console.log('inserted cache for', coinType, 'with priceUsd', priceUsd)

    return cacheData;
  } catch (error) {
    console.error('Error getting SUI token info:', error);
    // Return basic info if metadata fetch fails
    return {
      coinType,
      chain: chainId,
      name: coinType.split("::").pop() || "UNKNOWN",
      symbol: coinType.split("::").pop() || "UNKNOWN",
      decimals: coinType === "0x2::sui::SUI" ? 9 : 6,
      description: `Token at ${coinType}`,
      iconUrl: null
    };
  }
}