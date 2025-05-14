import { Connection, PublicKey } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import { CHAINS } from "../config.js";
import { PIVY_STEALTH_IDL } from "../lib/pivy-stealth/IDL.js";
import { prismaQuery } from "../lib/prisma.js";

/**
 *
 * @param {import("fastify").FastifyInstance} app
 * @param {*} _
 * @param {Function} done
 */
export const stealthWorkers = (app, _, done) => {

  const handleFetchStealthTransactions = async () => {
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
        limit: 20,
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
              timestamp: signature.blockTime
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
    if( results.length === 0 ){
      console.log('No new stealth transactions found');
      return;
    }

    for (const result of results) {
      if (result.type === 'IN') {
        await prismaQuery.payment.create({
          data: {
            txHash: result.signature,
            slot: result.slot,
            timestamp: result.data.timestamp,
            stealthOwnerPubkey: result.data.stealthOwner,
            ephemeralPubkey: result.data.ephemeralPubkey,
            payerPubKey: result.data.payer,
            mintAddress: result.data.mint,
            amount: result.data.amount,
            label: result.data.label,
            chain: chain.id, 
          }
        })
      }else if(result.type === 'OUT'){
        await prismaQuery.withdrawal.create({
          data: {
            txHash: result.signature,
            slot: result.slot,
            timestamp: result.data.timestamp,
            stealthOwnerPubkey: result.data.stealthOwner,
            destinationPubkey: result.data.destination,
            mintAddress: result.data.mint,
            amount: result.data.amount,
            chain: chain.id,
          }
        })
      }
    }

    console.log('Stealth Program event results: ', results)
  }

  handleFetchStealthTransactions()

  done();
}