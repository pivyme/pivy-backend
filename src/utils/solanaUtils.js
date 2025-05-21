import * as metaplex from '@metaplex-foundation/js';
import * as solanaWeb3 from '@solana/web3.js';
import { AccountLayout, getMint, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { getIPFSData } from './ipfsUtils.js';
import BN from 'bn.js';
import { sleep } from './miscUtils.js';
import axios from 'axios';
import { prismaQuery } from '../lib/prisma.js';

/**
 * Get the token info
 * @param {string} mintAddress - The mint address of the token
 * @param {Connection} connection - The Solana connection object
 * @returns {Promise<Object>} The token info
 */
export const getTokenInfo = async (mintAddress, connection) => {
  try {
    // Initialize Metaplex
    const _metaplex = metaplex.Metaplex.make(connection);

    // Get the metadata account and token data in parallel
    const [metadataAccount, token] = await Promise.all([
      _metaplex.nfts().pdas().metadata({ mint: new solanaWeb3.PublicKey(mintAddress) }),
      _metaplex.nfts().findByMint({ mintAddress: new solanaWeb3.PublicKey(mintAddress) })
    ]);

    const metadataAccountInfo = await connection.getAccountInfo(metadataAccount);
    if (!metadataAccountInfo) {
      throw new Error(`Metadata account not found for mint ${mintAddress}`);
    }

    // Fetch IPFS data in parallel if token URI exists
    let uriData = null;
    if (token?.uri) {
      try {
        const ipfsDataPromise = getIPFSData(token.uri);
        uriData = (await ipfsDataPromise)?.data;
      } catch (error) {
        console.error('Error fetching IPFS data:', error);
      }
    }

    // Calculate total supply
    const formattedTotalSupply = new BN(token.mint.supply.basisPoints)
      .div(new BN(10).pow(new BN(token.mint.decimals)))
      .toNumber();

    // Construct the token data object
    const tokenData = {
      address: token.mint.address.toBase58(),
      name: token.name,
      symbol: token.symbol,
      decimals: token.mint.decimals,
      uri: token.uri,
      description: uriData?.description || '',
      image: uriData?.image || '',
      totalSupply: formattedTotalSupply,
      uriData: uriData,
    };

    return tokenData;
  } catch (error) {
    console.error(`Error fetching token info: ${error.message}`);
    return null;
  }
};

/**
 * Get or create token cache entry
 * @param {string} mintAddress - The mint address of the token
 * @param {string} chain - The chain ID
 * @param {Connection} connection - The Solana connection object
 * @returns {Promise<Object>} The cached token data
 */
export const getOrCreateTokenCache = async (mintAddress, chain, connection) => {
  try {
    // Check if token exists in cache
    const existingCache = await prismaQuery.mintDataCache.findUnique({
      where: {
        mintAddress_chain: {
          mintAddress: mintAddress,
          chain: chain
        }
      }
    });

    if (existingCache && !existingCache.isInvalid) {
      return existingCache;
    }

    // Try to fetch token info first
    let tokenInfo = null;
    let decimals = 0;

    try {
      tokenInfo = await getTokenInfo(mintAddress, connection);
      decimals = tokenInfo.decimals;
    } catch (error) {
      console.error('Error fetching token info:', error.message);
      // If token info fails, try to at least get decimals from mint account
      try {
        const mintInfo = await getMint(
          connection,
          new solanaWeb3.PublicKey(mintAddress)
        );
        decimals = mintInfo.decimals;
      } catch (mintError) {
        console.error('Error fetching mint decimals:', mintError.message);
      }
    }

    // Create fallback data using the mint address
    const shortAddr = mintAddress.slice(0, 5).toUpperCase();
    const cacheData = {
      mintAddress: mintAddress,
      chain: chain,
      name: tokenInfo?.name || `Unknown Token ${shortAddr}`,
      symbol: tokenInfo?.symbol || shortAddr,
      decimals: decimals,
      imageUrl: tokenInfo?.image || null,
      description: tokenInfo?.description || `Token at address ${mintAddress}`,
      uriData: tokenInfo?.uriData || {},
      isInvalid: false
    };

    // Upsert the cache entry
    return await prismaQuery.mintDataCache.upsert({
      where: {
        mintAddress_chain: {
          mintAddress: mintAddress,
          chain: chain
        }
      },
      update: cacheData,
      create: cacheData
    });

  } catch (error) {
    console.error(`Error in getOrCreateTokenCache: ${error.message}`);
    throw error;
  }
};

export const getWalletsTokensHolding = async (addresses, connection) => {
  // Process all addresses in parallel for better performance
  const walletsPromises = addresses.map(async (address) => {
    console.log('address', address)
    const pubKey = new solanaWeb3.PublicKey(address);

    try {
      // Get native SOL balance
      const nativeBalance = await connection.getBalance(pubKey);

      // Get token accounts
      const tokenAccounts = await connection.getTokenAccountsByOwner(
        pubKey,
        { programId: TOKEN_PROGRAM_ID },
        'confirmed'
      );

      // Parse token accounts and filter out zero balances
      const tokenBalances = tokenAccounts.value
        .map(({ account }) => {
          const accountData = AccountLayout.decode(account.data);
          return {
            tokenAddress: new solanaWeb3.PublicKey(accountData.mint).toString(),
            amount: Number(accountData.amount)
          };
        })
        .filter(token => token.amount > 0); // Remove zero balance tokens

      return {
        address,
        nativeBalance: nativeBalance / solanaWeb3.LAMPORTS_PER_SOL, // Convert lamports to SOL
        tokenBalances
      };
    } catch (error) {
      console.error(`Error fetching balances for address ${address}:`, error);
      return {
        address,
        nativeBalance: 0,
        tokenBalances: []
      };
    } finally {
      await sleep(1500);
    }
  });

  return Promise.all(walletsPromises);
}

export const dexscreenerGetTokenPrice = async (tokenAddress) => {
  const res = await axios({
    url: `https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`,
    method: 'GET',
    headers: {
      'Content-Type': 'application/json'
    }
  });

  // Search on .pairs where first chainId is 'solana'
  const solanaPair = res.data.pairs.find(pair => pair.chainId === 'solana');
  const priceUsd = parseFloat(solanaPair.priceUsd);

  return priceUsd;
}

export const formatSolanaBalances = async (balances, chain, addressToEphemeralMap) => {
  const WRAPPED_SOL_MINT = "So11111111111111111111111111111111111111112";

  // Get unique token addresses from all balances
  const tokenAddresses = new Set([WRAPPED_SOL_MINT]); // Always include wrapped SOL
  balances.forEach(wallet => {
    wallet.tokenBalances.forEach(token => {
      tokenAddresses.add(token.tokenAddress);
    });
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

  // Helper function to format amount based on decimals
  const formatAmount = (amount, decimals) => {
    // Convert to string and split at decimal point
    const [whole, fraction = ""] = amount.toString().split(".");

    // If no decimal part, return as is
    if (!fraction) return amount;

    // Truncate to max decimals
    const truncated = fraction.slice(0, decimals);

    // Remove trailing zeros
    const cleaned = truncated.replace(/0+$/, "");

    // If only zeros after decimal, return whole number
    if (!cleaned) return Number(whole);

    // Combine whole and truncated fraction
    return Number(`${whole}.${cleaned}`);
  };

  // Initialize result structure
  const result = {
    native: {
      name: "Solana",
      symbol: "SOL",
      decimals: 9,
      imageUrl: "https://assets.coingecko.com/coins/images/4128/standard/solana.png?1718769756",
      total: 0,
      usdValue: 0,
      balances: []
    },
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
    // Add native balance
    const nativeAmount = wallet.nativeBalance;
    if (nativeAmount > 0) {
      result.native.total += nativeAmount;
      result.native.balances.push({
        address: wallet.address,
        ephemeralPubkey: addressToEphemeralMap.get(wallet.address),
        memo: addressToMemoMap.get(wallet.address),
        amount: formatAmount(nativeAmount, 9) // SOL has 9 decimals
      });
    }
  });
  // Format the native total
  result.native.total = formatAmount(result.native.total, 9);

  // Process token balances
  balances.forEach(wallet => {
    wallet.tokenBalances.forEach(token => {
      const tokenInfo = tokenInfoMap.get(token.tokenAddress);
      if (!tokenInfo) return; // Skip if no token info

      // Find existing token entry or create new one
      let tokenEntry = result.tokens.find(t => t.mintAddress === token.tokenAddress);

      if (!tokenEntry) {
        tokenEntry = {
          mintAddress: tokenInfo.mintAddress,
          name: tokenInfo.name,
          symbol: tokenInfo.symbol,
          decimals: tokenInfo.decimals,
          imageUrl: tokenInfo.imageUrl,
          total: 0,
          usdValue: 0,
          balances: []
        };
        result.tokens.push(tokenEntry);
      }

      // Calculate human readable amount with proper decimals
      const amount = token.amount / (10 ** tokenInfo.decimals);
      tokenEntry.total += amount;
      tokenEntry.balances.push({
        address: wallet.address,
        ephemeralPubkey: addressToEphemeralMap.get(wallet.address),
        memo: addressToMemoMap.get(wallet.address),
        amount: formatAmount(amount, tokenInfo.decimals)
      });
    });
  });

  // Format all token totals
  result.tokens.forEach(token => {
    token.total = formatAmount(token.total, token.decimals);
  });

  // Ensure wrapped SOL exists in the list
  const wrappedSolInfo = tokenInfoMap.get(WRAPPED_SOL_MINT);
  if (wrappedSolInfo && !result.tokens.find(t => t.mintAddress === WRAPPED_SOL_MINT)) {
    result.tokens.push({
      mintAddress: wrappedSolInfo.mintAddress,
      name: wrappedSolInfo.name,
      symbol: wrappedSolInfo.symbol,
      decimals: wrappedSolInfo.decimals,
      imageUrl: wrappedSolInfo.imageUrl,
      total: 0,
      usdValue: 0,
      balances: []
    });
  }

  // Sort tokens: Wrapped SOL first, then by USD value
  result.tokens.sort((a, b) => {
    if (a.mintAddress === WRAPPED_SOL_MINT) return -1;
    if (b.mintAddress === WRAPPED_SOL_MINT) return 1;
    return b.usdValue - a.usdValue;
  });

  return result;
}