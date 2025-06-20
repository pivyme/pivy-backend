import { SuiClient } from "@mysten/sui/client";
import { CHAINS, isTestnet, NATIVE_SUI_MINT } from "../../config.js";
import { prismaQuery } from "../../lib/prisma.js";
import bs58 from 'bs58';
import { getOrCreateSuiTokenCache } from "../../utils/suiUtils.js";
import { processPaymentTx } from "../solana/helpers/activityHelpers.js";
import { processSuiPaymentTx, processSuiWithdrawalTx } from "./helpers/suiActivityHelpers.js";
import cron from "node-cron";

const getOrCreateNativeSUICache = async (chainId) => {
  const existingCache = await prismaQuery.mintDataCache.findUnique({
    where: {
      mintAddress_chain: {
        mintAddress: NATIVE_SUI_MINT,
        chain: chainId
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
        mintAddress: NATIVE_SUI_MINT,
        chain: chainId
      }
    },
    update: {
      name: "Sui",
      symbol: "SUI",
      decimals: 9,
      imageUrl: "https://assets.coingecko.com/coins/images/26375/standard/sui-ocean-square.png?1727791290",
      description: "Native Sui token",
      uriData: {},
      isInvalid: false
    },
    create: {
      mintAddress: NATIVE_SUI_MINT,
      chain: chainId,
      name: "Sui",
      symbol: "SUI",
      decimals: 9,
      imageUrl: "https://assets.coingecko.com/coins/images/26375/standard/sui-ocean-square.png?1727791290",
      description: "Native Sui token",
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
export const suiStealthWorkers = (app, _, done) => {
  const handleFetchStealthTransactions = async () => {
    try {
      const chain = isTestnet ? CHAINS.SUI_TESTNET : CHAINS.SUI_MAINNET;
      // console.log('Fetching tx from', chain.pivyStealthProgramId)

      const latestPayment = await prismaQuery.payment.findFirst({
        where: { chain: chain.id },
        orderBy: { slot: 'desc' }
      });

      const lastProcessedSignature = latestPayment?.txHash;

      const client = new SuiClient({
        url: chain.rpcUrl
      })

      const txs = await client.queryTransactionBlocks({
        filter: {
          InputObject: chain.pivyStealthProgramId,
        },
        options: {
          showEvents: true,
          showInput: true,
        },
        limit: 8,
        descending: true,
      })

      if (txs.data.length === 0) {
        console.log('No new stealth transactions found');
        return;
      }

      const results = [];

      for (const tx of txs.data) {
        const existingPayment = await prismaQuery.payment.findUnique({
          where: { txHash: tx.digest }
        })

        if (existingPayment) continue;

        // Check if transaction has events
        if (!tx.events || tx.events.length === 0) {
          // console.log(`Transaction ${tx.digest} has no events, skipping`);
          continue;
        }

        const eventType = tx.events[0].type;
        // console.log('eventType: ', eventType)

        // console.log('tx: ', JSON.stringify(tx))

        if (eventType.includes('PaymentEvent')) {
          const eventData = tx.events[0].parsedJson;

          // convert ephemeral pubkey from bytes to base58
          const ephPubBytes = Buffer.from(eventData.eph_pubkey);
          const ephPubkey = Buffer.from(ephPubBytes.filter(byte => byte !== 0)).toString('utf8');

          // convert label from bytes to string (remove padding and convert)
          const labelBytes = Buffer.from(eventData.label);
          const label = Buffer.from(labelBytes.filter(byte => byte !== 0)).toString('utf8');

          const payloadBytes = Buffer.from(eventData.payload);
          const payload = Buffer.from(payloadBytes.filter(byte => byte !== 0)).toString('utf8');

          console.log('eventType: ', eventType)
          const mint = eventType.match(/<(.+?)>/)[1];

          results.push({
            signature: tx.digest,
            slot: parseInt(tx.checkpoint),
            type: 'IN',
            data: {
              stealthOwner: eventData.stealth_owner,
              payer: eventData.payer,
              mint: mint,
              amount: eventData.amount,
              label: label,
              ephemeralPubkey: ephPubkey,
              timestamp: parseInt(parseInt(tx.timestampMs) / 1000),
              // handle announcement, auto false for now
              announce: false,
              memo: payload,
            }
          })
        } else if (eventType.includes('WithdrawEvent')) {
          const eventData = tx.events[0].parsedJson;

          const mint = eventType.match(/<(.+?)>/)[1];

          results.push({
            signature: tx.digest,
            slot: parseInt(tx.checkpoint),
            type: 'OUT',
            data: {
              stealthOwner: eventData.stealth_owner,
              destination: eventData.destination,
              mint: mint,
              amount: eventData.amount,
              timestamp: parseInt(parseInt(tx.timestampMs) / 1000),
            }
          })
        }
      }

      if (results.length === 0) {
        console.log('No new stealth transactions found');
        return;
      }

      for (const result of results) {
        let tokenCache;
        if (result.data.mint === NATIVE_SUI_MINT) {
          tokenCache = await getOrCreateNativeSUICache(chain.id);
        } else {
          tokenCache = await getOrCreateSuiTokenCache(
            result.data.mint,
            chain.id
          )
        }


        const users = await prismaQuery.user.findMany({
          where: {
            walletChain: {
              in: ['SUI', 'SUI_ZKLOGIN']
            },
            metaViewPriv: {
              not: null
            },
            metaSpendPub: {
              not: null
            }
          }
        })

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

          await processSuiPaymentTx({
            txHash: newPayment.txHash,
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
            await processSuiWithdrawalTx({
              txHash: newWithdrawal.txHash
            });
          }
        }
      }

    } catch (error) {
      console.log('error in handleFetchStealthTransactions', error);
    }
  }

  handleFetchStealthTransactions();

  // Every 5 seconds
  cron.schedule('*/5 * * * * *', () => {
    handleFetchStealthTransactions()
  })

  done()
}