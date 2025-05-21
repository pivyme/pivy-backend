import { Connection, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { prismaQuery } from "../../lib/prisma.js";
import { getOrCreateTokenCache, getTokenInfo } from "../../utils/solanaUtils.js";

/**
 * Gets the portfolio information for a Solana address
 * @param {string} address - Wallet address
 * @param {Connection} connection - Connection object
 * @returns {Promise<{nativeBalance: object, splBalance: array}>}
 */
export async function getSolanaPortfolio(address, chainId, connection) {
  const publicKey = new PublicKey(address);

  // Fetch all token accounts by owner
  const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
    publicKey,
    {
      programId: TOKEN_PROGRAM_ID
    }
  );

  // Create an empty array to store the portfolio data
  const portfolioData = [];

  // Process each token account
  for (let i = 0; i < tokenAccounts.value.length; i++) {
    const accountInfo = tokenAccounts.value[i];
    const accountData = accountInfo.account.data.parsed.info;
    const mint = accountData.mint;

    // Fetch mint data asynchronously
    // const mintData = await fetchMintData(mint, accountData, chainId, rpcUrl);

    const mintData = await getOrCreateTokenCache(
      mint,
      chainId,
      connection
    )
    // Push the processed data into the portfolioData array
    portfolioData.push({
      mint: accountData.mint,
      owner: accountData.owner,
      tokenAmount: accountData.tokenAmount.uiAmount,
      token: {
        name: mintData.name,
        symbol: mintData.symbol,
        decimals: accountData.tokenAmount.decimals,
        imageUrl: mintData.imageUrl,
        description: mintData.description,
      }
    });
  }

  // Get Native SOL balance
  const balance = await connection.getBalance(publicKey)
  const nativeBalance = {
    name: "SOL",
    symbol: "SOL",
    decimals: 9,
    imageUrl: 'https://assets.coingecko.com/coins/images/4128/standard/solana.png?1718769756',
    amount: balance / LAMPORTS_PER_SOL,
  }

  return {
    nativeBalance,
    splBalance: portfolioData,
  };
}
