import { Connection, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { CHAINS } from "../config.js";
import { prismaQuery } from "../lib/prisma.js";
import { authMiddleware } from "../middlewares/authMiddleware.js";
import { TOKEN_PROGRAM_ID } from "@coral-xyz/anchor/dist/cjs/utils/token.js";
import { getTokenInfo, getWalletsTokensHolding } from "../utils/solanaUtils.js";

// Simple in-memory cache implementation
const balanceCache = new Map();
const CACHE_DURATION = 15 * 1000; // 15 seconds in milliseconds

// Balance cache for user balances
const userBalanceCache = new Map();
const USER_BALANCE_CACHE_DURATION = 30 * 1000; // 30 seconds in milliseconds

const getCachedBalance = (address) => {
  const cached = balanceCache.get(address);
  if (!cached) return null;

  // Check if cache has expired
  if (Date.now() - cached.timestamp > CACHE_DURATION) {
    balanceCache.delete(address);
    return null;
  }

  return cached.data;
};

const setCachedBalance = (address, data) => {
  balanceCache.set(address, {
    data,
    timestamp: Date.now()
  });
};

const getCachedUserBalance = (userId, chain) => {
  const key = `${userId}-${chain}`;
  const cached = userBalanceCache.get(key);
  if (!cached) return null;
  
  // Check if cache has expired
  if (Date.now() - cached.timestamp > USER_BALANCE_CACHE_DURATION) {
    userBalanceCache.delete(key);
    return null;
  }
  
  return cached.data;
};

const setCachedUserBalance = (userId, chain, data) => {
  const key = `${userId}-${chain}`;
  userBalanceCache.set(key, {
    data,
    timestamp: Date.now()
  });
};

async function formatBalances(balances, chain) {
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
    spl: []
  };

  // Process each wallet's balances
  balances.forEach(wallet => {
    // Add native balance
    const nativeAmount = wallet.nativeBalance / LAMPORTS_PER_SOL;
    if (nativeAmount > 0) {
      result.native.total += nativeAmount;
      result.native.balances.push({
        address: wallet.address,
        amount: nativeAmount
      });
    }

    // Process token balances
    wallet.tokenBalances.forEach(token => {
      const tokenInfo = tokenInfoMap.get(token.tokenAddress);
      if (!tokenInfo) return; // Skip if no token info

      // Find existing token entry or create new one
      let tokenEntry = result.spl.find(t => t.mintAddress === token.tokenAddress);
      
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
        result.spl.push(tokenEntry);
      }

      // Calculate human readable amount
      const amount = token.amount / (10 ** tokenInfo.decimals);
      tokenEntry.total += amount;
      tokenEntry.balances.push({
        address: wallet.address,
        amount: amount
      });
    });
  });

  // Calculate USD values (hardcoded $1 per token)
  result.native.usdValue = result.native.total * 1;
  result.spl.forEach(token => {
    token.usdValue = token.total * 1;
  });

  // Ensure wrapped SOL exists in the list
  const wrappedSolInfo = tokenInfoMap.get(WRAPPED_SOL_MINT);
  if (wrappedSolInfo && !result.spl.find(t => t.mintAddress === WRAPPED_SOL_MINT)) {
    result.spl.push({
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

  // Sort SPL tokens: Wrapped SOL first, then by USD value
  result.spl.sort((a, b) => {
    if (a.mintAddress === WRAPPED_SOL_MINT) return -1;
    if (b.mintAddress === WRAPPED_SOL_MINT) return 1;
    return b.usdValue - a.usdValue;
  });

  return result;
}

/**
 *
 * @param {import("fastify").FastifyInstance} app
 * @param {*} _
 * @param {Function} done
 */
export const userRoutes = (app, _, done) => {
  app.get('/username/check', async (request, reply) => {
    // Check if username is available
    try {
      const user = await prismaQuery.user.findUnique({
        where: {
          username: request.query.username
        }
      })

      return reply.status(200).send({
        isAvailable: !user
      })
    } catch (error) {
      console.log('Error checking username', error);
      return reply.status(500).send({
        message: "Error checking username",
        error: error.message,
        data: null,
      });
    }
  })

  app.post('/username/set', {
    preHandler: [authMiddleware]
  }, async (request, reply) => {
    try {
      const user = await prismaQuery.user.update({
        where: {
          id: request.user.id
        },
        data: {
          username: request.body.username,
        }
      })

      return reply.status(200).send(user);
    } catch (error) {
      console.log('Error setting username', error);
      return reply.status(500).send({
        message: "Error setting username",
        error: error.message,
        data: null,
      });
    }
  })

  app.get("/balance/:address", async (req, reply) => {
    try {
      const { address } = req.params;

      if (!address) {
        return reply.code(400).send({
          message: "Address is required",
        });
      }

      // Check cache first
      const cachedBalance = getCachedBalance(address);
      if (cachedBalance) {
        return reply.code(200).send(cachedBalance);
      }

      const chain = CHAINS[process.env.CHAIN]

      const connection = new Connection(chain.rpcUrl, "confirmed");
      const publicKey = new PublicKey(address);

      // Fetch all token accounts by owner
      const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
        publicKey,
        {
          programId: TOKEN_PROGRAM_ID
        }
      );

      const fetchMintData = async (mintAddress, tokenAccountData) => {
        let existingCache = await prismaQuery.mintDataCache.findUnique({
          where: {
            mintAddress_chain: {
              mintAddress: mintAddress,
              chain: chain.id
            }
          },
        });

        if (existingCache) {
          return existingCache;
        }

        const connection = new Connection(chain.rpcUrl, "confirmed");
        const tokenInfo = await getTokenInfo(
          mintAddress,
          connection
        )

        // Create fallback data using the mint address
        const shortAddr = mintAddress.slice(0, 5).toUpperCase();
        const fallbackData = {
          mintAddress: mintAddress,
          chain: chain.id,
          name: 'Unknown Token',
          symbol: shortAddr,
          decimals: tokenAccountData.tokenAmount.decimals,
          imageUrl: null,
          description: `Token at address ${mintAddress}`,
          uriData: {},
          isInvalid: false
        };

        if (!tokenInfo) {
          existingCache = await prismaQuery.mintDataCache.create({
            data: fallbackData
          })

          return existingCache;
        }

        existingCache = await prismaQuery.mintDataCache.create({
          data: {
            mintAddress: mintAddress,
            chain: chain.id,
            name: tokenInfo.name || fallbackData.name,
            symbol: tokenInfo.symbol || fallbackData.symbol,
            decimals: tokenInfo.decimals || tokenAccountData.tokenAmount.decimals,
            imageUrl: tokenInfo.image || fallbackData.imageUrl,
            description: tokenInfo.description || fallbackData.description,
            uriData: tokenInfo.uriData || fallbackData.uriData,
          }
        })

        return existingCache;
      };

      // Create an empty array to store the portfolio data
      const portfolioData = [];

      for (let i = 0; i < tokenAccounts.value.length; i++) {
        const accountInfo = tokenAccounts.value[i];
        const accountData = accountInfo.account.data.parsed.info;

        const mint = accountData.mint;

        // Fetch mint data asynchronously
        const mintData = await fetchMintData(mint, accountData);

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

      const portfolioInfo = {
        nativeBalance: nativeBalance,
        splBalance: portfolioData,
      };

      // Cache the result before sending
      setCachedBalance(address, portfolioInfo);

      return reply.code(200).send(portfolioInfo);

    } catch (error) {
      console.log("Error getting portfolio info: ", error)
      return reply.code(500).send({
        message: error.message,
        data: null,
      });
    }
  })

  app.get('/activities', {
    preHandler: [authMiddleware]
  }, async (request, reply) => {
    try {
      // Get all payments for the user's links
      const payments = await prismaQuery.payment.findMany({
        where: {
          link: {
            userId: request.user.id
          }
        },
        include: {
          // Include token data
          mint: {
            select: {
              name: true,
              symbol: true,
              decimals: true,
              imageUrl: true
            }
          },
          // Include link data
          link: {
            select: {
              label: true,
              emoji: true,
              backgroundColor: true,
              tag: true,
              type: true,
              amountType: true
            }
          }
        },
        orderBy: {
          timestamp: 'desc'
        }
      });

      // Transform the data for frontend consumption
      const activities = payments.map(payment => ({
        id: payment.txHash,
        type: 'PAYMENT',
        timestamp: payment.timestamp,
        amount: payment.amount.toString(),
        token: {
          symbol: payment.mint.symbol,
          name: payment.mint.name,
          decimals: payment.mint.decimals,
          imageUrl: payment.mint.imageUrl
        },
        link: payment.link ? {
          label: payment.link.label,
          emoji: payment.link.emoji,
          backgroundColor: payment.link.backgroundColor,
          tag: payment.link.tag,
          type: payment.link.type,
          amountType: payment.link.amountType
        } : null,
        from: payment.payerPubKey,
        isAnnounce: payment.announce,
        chain: payment.chain
      }));

      return reply.send(activities);
    } catch (error) {
      console.error('Error fetching activities:', error);
      return reply.status(500).send({
        success: false,
        error: 'Failed to fetch activities'
      });
    }
  })

  app.get('/balances', {
    preHandler: [authMiddleware]
  }, async (request, reply) => {
    try {
      const { chain = "DEVNET" } = request.query;

      // Check cache first
      const cachedBalance = getCachedUserBalance(request.user.id, chain);
      if (cachedBalance) {
        return reply.send(cachedBalance);
      }

      const connection = new Connection(CHAINS[chain].rpcUrl, "confirmed");

      // Get all user owned addresses that is in Payment table
      const allPayments = await prismaQuery.payment.findMany({
        where: {
          link: {
            userId: request.user.id
          }
        },
        select: {
          stealthOwnerPubkey: true
        },
        distinct: ['stealthOwnerPubkey'] // Only get unique addresses
      });

      const allAddresses = allPayments.map(payment => payment.stealthOwnerPubkey);
      console.log('All addresses', allAddresses);

      const balances = await getWalletsTokensHolding(allAddresses, connection);
      console.log('Raw balances', balances);

      // Format balances with token info
      const formattedBalances = await formatBalances(balances, CHAINS[chain].id);
      console.log('Formatted balances', formattedBalances);

      // Cache the formatted balances
      setCachedUserBalance(request.user.id, chain, formattedBalances);

      return reply.send(formattedBalances);
    } catch (error) {
      console.error('Error fetching balances:', error);
      return reply.status(500).send({
        error: 'Failed to fetch balances'
      });
    }
  })

  done();
}