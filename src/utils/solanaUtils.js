import * as metaplex from '@metaplex-foundation/js';
import * as solanaWeb3 from '@solana/web3.js';
import { AccountLayout, getMint, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { getIPFSData } from './ipfsUtils.js';
import BN from 'bn.js';
import { sleep } from './miscUtils.js';
import axios from 'axios';

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
export const getOrCreateTokenCache = async (mintAddress, chain, connection, prisma) => {
  try {
    // Check if token exists in cache
    const existingCache = await prisma.mintDataCache.findUnique({
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
    return await prisma.mintDataCache.upsert({
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