import { Connection, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { CHAINS } from "../config.js";
import { prismaQuery } from "../lib/prisma.js";
import { authMiddleware } from "../middlewares/authMiddleware.js";
import { TOKEN_PROGRAM_ID } from "@coral-xyz/anchor/dist/cjs/utils/token.js";
import { getTokenInfo, getWalletsTokensHolding, formatSolanaBalances } from "../utils/solanaUtils.js";
import { getSolanaPortfolio } from "../helpers/solana/solanaHelpers.js";
import { SuiClient } from "@mysten/sui/client";
import { getSuiPortfolio } from "../helpers/sui/suiHelpers.js";
import { getSuiWalletsTokensHolding, formatSuiBalances } from "../utils/suiUtils.js";

// Simple in-memory cache implementation
const balanceCache = new Map();
const CACHE_DURATION = 5 * 1000; // 15 seconds in milliseconds

// Balance cache for user balances
const userBalanceCache = new Map();
const USER_BALANCE_CACHE_DURATION = 5 * 1000; // 30 seconds in milliseconds

const getCachedBalance = (address, chain) => {
  const key = `${chain.id}_${address}`;
  const cached = balanceCache.get(key);
  if (!cached) return null;

  // Check if cache has expired
  if (Date.now() - cached.timestamp > CACHE_DURATION) {
    balanceCache.delete(key);
    return null;
  }

  return cached.data;
};

const setCachedBalance = (address, chain, data) => {
  const key = `${chain.id}_${address}`;
  balanceCache.set(key, {
    data,
    timestamp: Date.now()
  });
};

const getCachedUserBalance = (userId, chain) => {
  const key = `${chain.id}_${userId}`;
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
  const key = `${chain.id}_${userId}`;
  userBalanceCache.set(key, {
    data,
    timestamp: Date.now()
  });
};

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
      const chainQuery = req.query.chain;
      console.log('chainQuery', chainQuery)

      if (!address) {
        return reply.code(400).send({
          message: "Address is required",
        });
      }

      const chain = CHAINS[chainQuery]
      if (!chain?.id) {
        return reply.code(400).send({
          message: "Invalid chain",
        });
      }

      // Check cache first with chain-specific key
      const cachedBalance = getCachedBalance(address, chain);
      if (cachedBalance) {
        return reply.code(200).send(cachedBalance);
      }

      // Solana
      if (chain.id === "MAINNET" || chain.id === "DEVNET") {
        const connection = new Connection(chain.rpcUrl, "confirmed");
        const portfolioInfo = await getSolanaPortfolio(address, chain.id, connection);

        // Cache the result before sending with chain-specific key
        setCachedBalance(address, chain, portfolioInfo);

        return reply.code(200).send(portfolioInfo);
      }

      // Sui
      if (chain.id === "SUI_MAINNET" || chain.id === "SUI_TESTNET") {
        const suiClient = new SuiClient({
          url: chain.rpcUrl
        })
        const portfolioInfo = await getSuiPortfolio(address, chain.id, suiClient)

        // Cache the result before sending with chain-specific key
        setCachedBalance(address, chain, portfolioInfo);

        return reply.code(200).send(portfolioInfo);
      }
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
      const chain = CHAINS[request.query.chain]
      if (!chain) {
        return reply.code(400).send({
          message: "Invalid chain",
        });
      }

      // Get all payments for the user's links
      const payments = await prismaQuery.payment.findMany({
        where: {
          link: {
            userId: request.user.id
          },
          chain: chain.id
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

      // Get all withdrawals for the user
      const withdrawals = await prismaQuery.withdrawal.findMany({
        where: {
          userId: request.user.id
        },
        include: {
          mint: {
            select: {
              name: true,
              symbol: true,
              decimals: true,
              imageUrl: true
            }
          }
        },
        orderBy: {
          timestamp: 'desc'
        }
      });

      // Group withdrawals by txHash and calculate totals
      const groupedWithdrawals = withdrawals.reduce((acc, withdrawal) => {
        if (!acc[withdrawal.txHash]) {
          acc[withdrawal.txHash] = {
            id: withdrawal.txHash,
            type: 'WITHDRAWAL',
            timestamp: withdrawal.timestamp,
            chain: withdrawal.chain,
            destinationPubkey: withdrawal.destinationPubkey,
            // Group amounts by token
            tokens: {}
          };
        }

        // Add or update token amount
        const token = withdrawal.mint;
        const tokenKey = token.symbol;
        if (!acc[withdrawal.txHash].tokens[tokenKey]) {
          acc[withdrawal.txHash].tokens[tokenKey] = {
            symbol: token.symbol,
            name: token.name,
            decimals: token.decimals,
            imageUrl: token.imageUrl,
            total: "0"
          };
        }

        // Add the amounts (they are strings, so we need to convert to BigInt)
        const currentTotal = BigInt(acc[withdrawal.txHash].tokens[tokenKey].total);
        const newAmount = BigInt(withdrawal.amount);
        acc[withdrawal.txHash].tokens[tokenKey].total = (currentTotal + newAmount).toString();

        return acc;
      }, {});

      // Transform withdrawals into the same format as payments
      const withdrawalActivities = Object.values(groupedWithdrawals).map(withdrawal => {
        // Get the first token's info for the main activity display
        const [firstToken, ...otherTokens] = Object.values(withdrawal.tokens);
        return {
          ...withdrawal,
          amount: firstToken.total,
          token: {
            symbol: firstToken.symbol,
            name: firstToken.name,
            decimals: firstToken.decimals,
            imageUrl: firstToken.imageUrl
          },
          // Include other tokens if there are any
          additionalTokens: otherTokens.length > 0 ? otherTokens : undefined
        };
      });

      // Transform payment data for frontend consumption
      const paymentActivities = payments.map(payment => ({
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

      // Combine and sort all activities by timestamp
      const allActivities = [...paymentActivities, ...withdrawalActivities]
        .sort((a, b) => b.timestamp - a.timestamp);

      return reply.send(allActivities);
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
      // const { chain = "DEVNET" } = request.query;
      const chain = CHAINS[request.query.chain]
      if (!chain) {
        return reply.code(400).send({
          message: "Invalid chain",
        });
      }

      if (chain.id === "DEVNET" || chain.id === "MAINNET") {

        // Check cache first
        const cachedBalance = getCachedUserBalance(request.user.id, chain);
        if (cachedBalance) {
          return reply.send(cachedBalance);
        }

        const connection = new Connection(chain.rpcUrl, "confirmed");

        // Get all user owned addresses that is in Payment table
        const allPayments = await prismaQuery.payment.findMany({
          where: {
            link: {
              userId: request.user.id
            }
          },
          select: {
            stealthOwnerPubkey: true,
            ephemeralPubkey: true,
            memo: true
          },
          distinct: ['stealthOwnerPubkey']
        });

        // Create a map of address to ephemeral key
        const addressToEphemeralMap = new Map(
          allPayments.map(p => [p.stealthOwnerPubkey, p.ephemeralPubkey])
        );

        const allAddresses = allPayments.map(payment => payment.stealthOwnerPubkey);
        // console.log('All addresses', allAddresses);

        const balances = await getWalletsTokensHolding(allAddresses, connection);
        // console.log('Raw balances', balances);

        // Format balances with token info and ephemeral keys
        const formattedBalances = await formatSolanaBalances(balances, chain.id, addressToEphemeralMap);
        // console.log('Formatted balances', formattedBalances);

        // Get SOL price from mintDataCache
        const solCache = await prismaQuery.mintDataCache.findUnique({
          where: {
            mintAddress_chain: {
              mintAddress: 'So11111111111111111111111111111111111111112',
              chain: chain.id
            }
          },
          select: {
            priceUsd: true
          }
        });

        // Get all token mint addresses from balances
        const tokenMints = formattedBalances.tokens.map(t => t.mintAddress);

        // Get all token prices from mintDataCache
        const tokenPrices = await prismaQuery.mintDataCache.findMany({
          where: {
            AND: [
              { mintAddress: { in: tokenMints } },
              { chain: chain.id }
            ]
          },
          select: {
            mintAddress: true,
            priceUsd: true
          }
        });

        // Create price lookup map
        const priceMap = new Map(tokenPrices.map(t => [t.mintAddress, t.priceUsd ?? 0]));

        // Update native SOL USD value
        formattedBalances.native.usdValue = formattedBalances.native.total * (solCache?.priceUsd ?? 0);

        // Update token USD values
        formattedBalances.tokens = formattedBalances.tokens.map(token => ({
          ...token,
          usdValue: token.total * (priceMap.get(token.mintAddress) ?? 0)
        }));

        // Remove the tokens that have total less than 0.00001
        formattedBalances.tokens = formattedBalances.tokens.filter(token => token.total > 0.00001);

        // Cache the formatted balances
        setCachedUserBalance(request.user.id, chain, formattedBalances);

        return reply.send(formattedBalances);
      } else if (chain.id === "SUI_MAINNET" || chain.id === "SUI_TESTNET") {
        // Check cache first
        const cachedBalance = getCachedUserBalance(request.user.id, chain);
        if (cachedBalance) {
          return reply.send(cachedBalance);
        }

        const allPayments = await prismaQuery.payment.findMany({
          where: {
            link: {
              userId: request.user.id
            }
          },
          select: {
            stealthOwnerPubkey: true,
            ephemeralPubkey: true,
            memo: true
          },
          distinct: ['stealthOwnerPubkey']
        })

        const addressToEphemeralMap = new Map(
          allPayments.map(p => [p.stealthOwnerPubkey, p.ephemeralPubkey])
        );

        const allAddresses = allPayments.map(payment => payment.stealthOwnerPubkey);
        const balances = await getSuiWalletsTokensHolding(allAddresses, chain.id)

        // Format balances using the new formatter
        const formattedBalances = await formatSuiBalances(balances, chain.id, addressToEphemeralMap);

        // Cache the formatted balances
        setCachedUserBalance(request.user.id, chain, formattedBalances);

        return reply.send(formattedBalances);
      }
    } catch (error) {
      console.error('Error fetching balances:', error);
      return reply.status(500).send({
        error: 'Failed to fetch balances'
      });
    }
  })

  done();

}