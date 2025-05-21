import { SuiClient } from "@mysten/sui/client";
import { CHAINS } from "../config.js";
import { prismaQuery } from "../lib/prisma.js";
import { getSuiPortfolio } from "../helpers/sui/suiHelpers.js";
import { sleep } from "./miscUtils.js";

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

export const getSuiWalletsTokensHolding = async (addresses, chainId) => {
  const chain = CHAINS[chainId]
  if (!chain) {
    throw new Error(`Invalid chainId: ${chainId}`)
  }

  const suiClient = new SuiClient({
    url: chain.rpcUrl
  })

  let allBalances = []
  for (const address of addresses) {
    const balances = await getSuiPortfolio(address, chainId, suiClient)
    allBalances.push({
      ...balances,
      address // Add the address to the balance object
    })
  }

  return allBalances
}

export const formatSuiBalances = async (balances, chain, addressToEphemeralMap) => {
  // Get unique token addresses from all balances
  const tokenAddresses = new Set(['0x2::sui::SUI']); // Always include native SUI
  balances.forEach(wallet => {
    if (wallet.tokenBalance && wallet.tokenBalance.length > 0) {
      wallet.tokenBalance.forEach(token => {
        tokenAddresses.add(token.mint);
      });
    }
  });

  // Fetch all token info from cache
  const tokenInfos = await prismaQuery.mintDataCache.findMany({
    where: {
      mintAddress: {
        in: Array.from(tokenAddresses)
      },
      chain: chain
    }
  });

  // Create token info map for quick lookup
  const tokenInfoMap = new Map(
    tokenInfos.map(info => [info.mintAddress, info])
  );

  // Initialize result structure
  const result = {
    tokens: []
  };

  // Get all payments to fetch memos
  const allPayments = await prismaQuery.payment.findMany({
    where: {
      stealthOwnerPubkey: {
        in: balances.map(b => b.address)
      }
    },
    select: {
      stealthOwnerPubkey: true,
      memo: true
    }
  });

  // Create a map of address to memo
  const addressToMemoMap = new Map();
  allPayments.forEach(payment => {
    if (payment.memo) {
      // First remove the array index if it exists
      const withoutIndex = payment.memo.replace(/^\[\d+\]\s*/, '');
      // Then try to extract content from angle brackets if they exist
      const memoMatch = withoutIndex.match(/<(.+)>/);
      const cleanMemo = memoMatch ? memoMatch[1] : withoutIndex;
      addressToMemoMap.set(payment.stealthOwnerPubkey, cleanMemo);
    }
  });

  // Process each wallet's balances
  balances.forEach(wallet => {
    // Add native balance as a token
    const nativeAmount = wallet.nativeBalance.amount;
    if (nativeAmount > 0) {
      // Find existing native token entry or create new one
      let nativeTokenEntry = result.tokens.find(t => t.mintAddress === '0x2::sui::SUI');
      
      if (!nativeTokenEntry) {
        // Get price info from cache
        const nativeTokenInfo = tokenInfoMap.get('0x2::sui::SUI');
        
        nativeTokenEntry = {
          mintAddress: '0x2::sui::SUI',
          name: "Sui",
          symbol: "SUI",
          decimals: 9,
          imageUrl: "https://assets.coingecko.com/coins/images/26375/standard/sui-ocean-square.png?1727791290",
          total: 0,
          usdValue: 0,
          priceUsd: nativeTokenInfo?.priceUsd || 0,
          balances: []
        };
        result.tokens.push(nativeTokenEntry);
      }

      nativeTokenEntry.total += nativeAmount;
      nativeTokenEntry.balances.push({
        address: wallet.address,
        ephemeralPubkey: addressToEphemeralMap.get(wallet.address),
        memo: addressToMemoMap.get(wallet.address),
        amount: nativeAmount
      });
    }

    // Process token balances
    if (wallet.tokenBalance && wallet.tokenBalance.length > 0) {
      wallet.tokenBalance.forEach(token => {
        // Skip if token has no amount or is invalid
        if (!token || !token.tokenAmount || token.tokenAmount <= 0) return;

        // Find existing token entry or create new one
        let tokenEntry = result.tokens.find(t => t.mintAddress === token.mint);

        if (!tokenEntry) {
          // Get price info from cache
          const tokenInfo = tokenInfoMap.get(token.mint);
          
          tokenEntry = {
            mintAddress: token.mint,
            name: token.token.name,
            symbol: token.token.symbol,
            decimals: token.token.decimals,
            imageUrl: token.token.imageUrl,
            total: 0,
            usdValue: 0,
            priceUsd: tokenInfo?.priceUsd || 0,
            balances: []
          };
          result.tokens.push(tokenEntry);
        }

        tokenEntry.total += token.tokenAmount;
        tokenEntry.balances.push({
          address: wallet.address,
          ephemeralPubkey: addressToEphemeralMap.get(wallet.address),
          memo: addressToMemoMap.get(wallet.address),
          amount: token.tokenAmount
        });
      });
    }
  });

  // Calculate USD values for all tokens
  result.tokens.forEach(token => {
    token.usdValue = token.total * token.priceUsd;
  });

  // Remove tokens with negligible balances
  result.tokens = result.tokens.filter(token => token.total > 0.00001);

  // Sort tokens by USD value
  result.tokens.sort((a, b) => b.usdValue - a.usdValue);

  return result;
}