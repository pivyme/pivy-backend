import { Connection, PublicKey } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import { CHAINS } from "../../config.js";
import { PIVY_STEALTH_IDL } from "../../lib/pivy-stealth/IDL.js";
import { prismaQuery } from "../../lib/prisma.js";
import { processPaymentTx, processWithdrawalTx } from "./helpers/activityHelpers.js";
import { getOrCreateTokenCache } from "../../utils/solanaUtils.js";

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
 * Extract memo data from transaction instructions
 */
const extractMemoFromTransaction = (transaction) => {
  if (!transaction?.transaction?.message?.instructions) {
    return null;
  }

  const memoInstruction = transaction.transaction.message.instructions.find(
    instruction => {
      // Check if the program ID matches the memo program ID
      const programId = transaction.transaction.message.accountKeys[instruction.programIdIndex].toBase58();
      return programId === MEMO_PROGRAM_ID;
    }
  );

  if (!memoInstruction) {
    return null;
  }

  try {
    // Decode the memo data
    const memoData = Buffer.from(memoInstruction.data, 'base64').toString('utf8');
    return memoData;
  } catch (error) {
    console.error('Error decoding memo:', error);
    return null;
  }
};

/**
 * Process a new stealth transaction
 */
const processStealthTransaction = async (signatureInfo, chain, connection, parser) => {
  try {
    const signature = signatureInfo.signature;
    // Check if the signature is already in the database
    const existingPayment = await prismaQuery.payment.findUnique({
      where: { txHash: signature }
    });

    const existingWithdrawal = await prismaQuery.withdrawal.findFirst({
      where: {
        txHash: signature,
      }
    });

    if (existingPayment || existingWithdrawal) {
      console.log('Transaction already processed:', signature);
      return;
    }

    console.log('Processing new transaction:', signature);

    // Get transaction details
    const transaction = await connection.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0
    });

    if (!transaction?.meta?.logMessages) return;

    const slot = transaction.slot;
    const timestamp = transaction.blockTime;

    // Parse transaction logs
    for (const event of parser.parseLogs(transaction.meta.logMessages)) {
      let tokenCache;

      if (event.name === "PaymentEvent") {
        const eventData = event.data;
        const mint = eventData.mint.toBase58();

        // Handle token caching
        if (mint === NATIVE_SOL_MINT) {
          tokenCache = await getOrCreateNativeSOLCache(chain.id);
        } else {
          tokenCache = await getOrCreateTokenCache(
            mint,
            chain.id,
            connection
          );
        }

        // Create new payment
        const newPayment = await prismaQuery.payment.create({
          data: {
            txHash: signature,
            slot: slot,
            timestamp: timestamp,
            stealthOwnerPubkey: eventData.stealthOwner.toBase58(),
            ephemeralPubkey: eventData.ephPubkey.toBase58(),
            payerPubKey: eventData.payer.toBase58(),
            amount: Number(eventData.amount).toString(),
            label: Buffer.from(eventData.label).toString("utf8").replace(/\0/g, ""),
            memo: signatureInfo.memo,
            announce: eventData.announce,
            chain: chain.id,
            mint: {
              connect: {
                id: tokenCache.id
              }
            }
          }
        });

        await processPaymentTx({
          txHash: newPayment.txHash
        });
      }

      if (event.name === "WithdrawEvent") {
        const eventData = event.data;
        const mint = eventData.mint.toBase58();

        // Check if withdrawal already exists
        const existingWithdrawal = await prismaQuery.withdrawal.findUnique({
          where: {
            txHash_stealthOwnerPubkey: {
              txHash: signature,
              stealthOwnerPubkey: eventData.stealthOwner.toBase58()
            }
          }
        });

        if (existingWithdrawal) {
          // console.log('Withdrawal already exists:', {
          //   txHash: signature,
          //   stealthOwnerPubkey: eventData.stealthOwner.toBase58()
          // });
          continue;
        }

        // Handle token caching
        if (mint === NATIVE_SOL_MINT) {
          tokenCache = await getOrCreateNativeSOLCache(chain.id);
        } else {
          tokenCache = await getOrCreateTokenCache(
            mint,
            chain.id,
            connection
          );
        }

        // Create new withdrawal
        const newWithdrawal = await prismaQuery.withdrawal.create({
          data: {
            txHash: signature,
            slot: slot,
            timestamp: timestamp,
            stealthOwnerPubkey: eventData.stealthOwner.toBase58(),
            destinationPubkey: eventData.destination.toBase58(),
            amount: Number(eventData.amount).toString(),
            chain: chain.id,
            mint: {
              connect: {
                id: tokenCache.id
              }
            }
          }
        }).catch(err => {
          console.log('Error creating withdrawal:', err);
        });

        if (newWithdrawal) {
          await processWithdrawalTx({
            txHash: newWithdrawal.txHash
          });
        }
      }
    }
  } catch (error) {
    console.error('Error processing transaction:', error);
  }
};

/**
 *
 * @param {import("fastify").FastifyInstance} app
 * @param {*} _
 * @param {Function} done
 */
export const stealthListener = (app, _, done) => {
  const startListener = async () => {
    try {
      const chain = CHAINS[process.env.CHAIN || 'DEVNET'];
      const stealthProgramId = new PublicKey(chain.pivyStealthProgramId);
      const connection = new Connection(chain.ws, "confirmed");
      
      const parser = new anchor.EventParser(
        stealthProgramId,
        new anchor.BorshCoder(PIVY_STEALTH_IDL)
      );

      console.log('Starting stealth program listener...');

      // Listen for program account changes
      connection.onProgramAccountChange(
        stealthProgramId,
        async (accountInfo, context) => {
          // Get the full signature info for the slot
          const signatures = await connection.getSignaturesForAddress(
            stealthProgramId,
            { limit: 1 }
          );
          if (signatures.length > 0) {
            await processStealthTransaction(signatures[0], chain, connection, parser);
          }
        },
        "confirmed"
      );

      // Listen for new signatures
      const subId = connection.onLogs(
        stealthProgramId,
        async (logs, context) => {
          if (logs.err) return;
          // Get the full signature info
          const signatures = await connection.getSignaturesForAddress(
            stealthProgramId,
            { 
              limit: 1,
              until: context.signature 
            }
          );
          if (signatures.length > 0) {
            await processStealthTransaction(signatures[0], chain, connection, parser);
          }
        },
        "confirmed"
      );

      // Handle cleanup
      process.on('SIGINT', () => {
        console.log('Removing stealth program listener...');
        connection.removeProgramAccountChangeListener(subId);
        process.exit();
      });

    } catch (error) {
      console.error('Error in stealth listener:', error);
    }
  };

  startListener();
  done();
}; 