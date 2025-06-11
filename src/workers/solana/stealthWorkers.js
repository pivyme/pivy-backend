import { Connection, PublicKey } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import { CHAINS } from "../../config.js";
import { PIVY_STEALTH_IDL } from "../../lib/pivy-stealth/IDL.js";
import { prismaQuery } from "../../lib/prisma.js";
import { processPaymentTx, processWithdrawalTx } from "./helpers/activityHelpers.js";
import { getOrCreateTokenCache } from "../../utils/solanaUtils.js";
import cron from "node-cron";

const NATIVE_SOL_MINT = "So11111111111111111111111111111111111111112";
const MEMO_PROGRAM_ID = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

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
        const existingWithdrawal = await prismaQuery.withdrawal.findFirst({
          where: {
            txHash: signature.signature,
          }
        })

        if (existingPayment) continue;

        const transaction = await connection.getTransaction(signature.signature, {
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0
        });
        if (!transaction?.meta?.logMessages) continue;

        for (const event of parser.parseLogs(transaction.meta.logMessages)) {
          if (event.name === "PaymentEvent") {
            // Extract memo from transaction
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
                announce: eventData.announce,
                memo: signature.memo
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
                timestamp: signature.blockTime,
              },
            });
          }
        }
      }

      if (results.length === 0) {
        console.log('No new stealth transactions found');
        return;
      }

      for (const result of results) {
        // Handle token caching
        let tokenCache;
        if (result.data.mint === NATIVE_SOL_MINT) {
          tokenCache = await getOrCreateNativeSOLCache(chain.id);
        } else {
          tokenCache = await getOrCreateTokenCache(
            result.data.mint,
            chain.id,
            connection
          );
        }

        const users = await prismaQuery.user.findMany({
          where: {
            walletChain: 'SOLANA',
            metaViewPriv: {
              not: null
            },
            metaSpendPub: {
              not: null
            }
          }
        })

        if (result.type === 'IN') {
          if (result.data.announce === true) {
            // Skip announcement payments
            continue;
          }

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
              memo: result.data.memo,
              announce: result.data.announce,
              chain: chain.id,
              mint: {
                connect: {
                  id: tokenCache.id
                }
              }
            }
          }).catch(err => {
            console.log('Error creating payment: ', err)
          });

          await processPaymentTx({
            txHash: result.signature,
            users: users
          })
        } else if (result.type === 'OUT') {
          // Check if withdrawal already exists
          const existingWithdrawal = await prismaQuery.withdrawal.findUnique({
            where: {
              txHash_stealthOwnerPubkey: {
                txHash: result.signature,
                stealthOwnerPubkey: result.data.stealthOwner
              }
            }
          });

          if (existingWithdrawal) {
            // console.log('Withdrawal already exists:', {
            //   txHash: result.signature,
            //   stealthOwnerPubkey: result.data.stealthOwner
            // });
            continue;
          }

          const newWithdrawal = await prismaQuery.withdrawal.create({
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
          }).catch(err => {
            console.log('Error creating withdrawal: ', err)
          });

          if (newWithdrawal) {
            await processWithdrawalTx({
              txHash: newWithdrawal.txHash
            });
          }
        }
      }

      // console.log('Stealth Program event results: ', results)
    } catch (error) {
      console.error('Error fetching stealth transactions:', error);
    }
  }
  // handleFetchStealthTransactions()

  // Every 5 seconds
  cron.schedule('*/5 * * * * *', () => {
    handleFetchStealthTransactions()
  })
  // handleFetchStealthTransactions()

  done();
}