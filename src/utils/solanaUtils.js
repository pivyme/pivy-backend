import * as metaplex from '@metaplex-foundation/js';
import * as solanaWeb3 from '@solana/web3.js';
import { getIPFSData } from './ipfsUtils.js';
import BN from 'bn.js';

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
