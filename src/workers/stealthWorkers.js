import { Connection, PublicKey } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import { CHAINS } from "../config.js";
import { PIVY_STEALTH_IDL } from "../lib/pivy-stealth/IDL.js";
import { prismaQuery } from "../lib/prisma.js";
import { processPaymentTx } from "./helpers/activityHelpers.js";
import { getOrCreateTokenCache } from "../utils/solanaUtils.js";
import cron from "node-cron";

const NATIVE_SOL_MINT = "So11111111111111111111111111111111111111112";

/**
 * Get or create native SOL token cache
 */
const getOrCreateNativeSOLCache = async (chain) => {
  const existingCache = await prismaQuery.mintDataCache.findUnique({
    where: {
      mintAddress_chain: {
        mintAddress: NATIVE_SOL_MINT,
        chain: chain
      }
    }
  });

  if (existingCache && !existingCache.isInvalid) {
    return existingCache;
  }

  // Create native SOL cache
  return await prismaQuery.mintDataCache.upsert({
    where: {
      mintAddress_chain: {
        mintAddress: NATIVE_SOL_MINT,
        chain: chain
      }
    },
    update: {
      name: "Solana",
      symbol: "SOL",
      decimals: 9,
      imageUrl: "https://assets.coingecko.com/coins/images/54252/standard/solana.jpg?1738911214",
      description: "Native Solana token",
      uriData: {},
      isInvalid: false
    },
    create: {
      mintAddress: NATIVE_SOL_MINT,
      chain: chain,
      name: "Solana",
      symbol: "SOL",
      decimals: 9,
      imageUrl: "https://assets.coingecko.com/coins/images/54252/standard/solana.jpg?1738911214",
      description: "Native Solana token",
      uriData: {},
      isInvalid: false
    }
  });
};

/**
 *
 * @param {import("fastify").FastifyInstance} app
 * @param {*} _
 * @param {Function} done
 */
export const stealthWorkers = (app, _, done) => {

  const handleFetchStealthTransactions = async () => {
    try {
      const chain = CHAINS[process.env.CHAIN || 'DEVNET'];

      const stealthProgramId = new PublicKey(chain.pivyStealthProgramId);
      const connection = new Connection(chain.rpcUrl, "confirmed")

      // Get latest recorded transactions from database
      const latestPayment = await prismaQuery.payment.findFirst({
        where: { chain: chain.id },
        orderBy: { slot: 'desc' }
      });

      const latestWithdrawal = await prismaQuery.withdrawal.findFirst({
        where: { chain: chain.id },
        orderBy: { slot: 'desc' }
      });

      // Get the latest signature from both tables
      const lastProcessedSignature = latestPayment?.txHash || latestWithdrawal?.txHash;

      // Get latest signatures for the program id
      const sigs = await connection.getSignaturesForAddress(
        stealthProgramId,
        {
          limit: 10,
          until: lastProcessedSignature
        }
      )
      console.log('sigs: ', sigs)

      // No need to filter signatures anymore since we're using 'until'
      if (sigs.length === 0) {
        console.log('No new stealth transactions found');
        return;
      }

      const parser = new anchor.EventParser(
        stealthProgramId,
        new anchor.BorshCoder(PIVY_STEALTH_IDL)
      );

      const results = []

      for (const signature of sigs) {
        // Check if the signature is already in the database
        const existingPayment = await prismaQuery.payment.findUnique({
          where: { txHash: signature.signature }
        });
        const existingWithdrawal = await prismaQuery.withdrawal.findUnique({
          where: { txHash: signature.signature }
        });

        if (existingPayment || existingWithdrawal) continue;

        console.log('Processing signature: ', signature.signature)

        const transaction = await connection.getTransaction(signature.signature, { commitment: "confirmed" });
        if (!transaction?.meta?.logMessages) continue;

        for (const event of parser.parseLogs(transaction.meta.logMessages)) {
          if (event.name === "PaymentEvent") {
            const eventData = event.data;
            results.push({
              signature: signature.signature,
              slot: signature.slot,
              type: "IN",
              data: {
                stealthOwner: eventData.stealthOwner.toBase58(),
                payer: eventData.payer.toBase58(),
                mint: eventData.mint.toBase58(),
                amount: Number(eventData.amount).toString(),
                label: Buffer.from(eventData.label).toString("utf8").replace(/\0/g, ""),
                ephemeralPubkey: eventData.ephPubkey.toBase58(),
                timestamp: signature.blockTime,
                announce: eventData.announce
              },
            });
          }
          if (event.name === "WithdrawEvent") {
            const eventData = event.data;
            results.push({
              signature: signature.signature,
              slot: signature.slot,
              type: "OUT",
              data: {
                stealthOwner: eventData.stealthOwner.toBase58(),
                destination: eventData.destination.toBase58(),
                mint: eventData.mint.toBase58(),
                amount: Number(eventData.amount).toString(),
                timestamp: signature.blockTime
              },
            });
          }
        }
      }

      console.log('Stealth Program event results: ', results)
      if (results.length === 0) {
        console.log('No new stealth transactions found');
        return;
      }

      for (const result of results) {
        console.log('result: ', result)

        // Handle token caching
        let tokenCache;
        if (result.data.mint === NATIVE_SOL_MINT) {
          tokenCache = await getOrCreateNativeSOLCache(chain.id);
        } else {
          tokenCache = await getOrCreateTokenCache(
            result.data.mint,
            chain.id,
            connection,
            prismaQuery
          );
        }

        const users = await prismaQuery.user.findMany({})

        if (result.type === 'IN') {
          const newPayment = await prismaQuery.payment.create({
            data: {
              txHash: result.signature,
              slot: result.slot,
              timestamp: result.data.timestamp,
              stealthOwnerPubkey: result.data.stealthOwner,
              ephemeralPubkey: result.data.ephemeralPubkey,
              payerPubKey: result.data.payer,
              amount: result.data.amount,
              label: result.data.label,
              announce: result.data.announce,
              chain: chain.id,
              mint: {
                connect: {
                  id: tokenCache.id
                }
              }
            }
          })

          await processPaymentTx({
            txHash: newPayment.txHash,
            users: users
          })
        } else if (result.type === 'OUT') {
          await prismaQuery.withdrawal.create({
            data: {
              txHash: result.signature,
              slot: result.slot,
              timestamp: result.data.timestamp,
              stealthOwnerPubkey: result.data.stealthOwner,
              destinationPubkey: result.data.destination,
              amount: result.data.amount,
              chain: chain.id,
              mint: {
                connect: {
                  id: tokenCache.id
                }
              }
            }
          })
        }
      }

      console.log('Stealth Program event results: ', results)
    } catch (error) {
      console.error('Error fetching stealth transactions:', error);
    }
  }
  // handleFetchStealthTransactions()

  // Every 5 seconds
  cron.schedule('*/45 * * * * *', () => {
    handleFetchStealthTransactions()
  })

  done();
}