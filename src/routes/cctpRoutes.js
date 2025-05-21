import bs58 from 'bs58'
import axios from 'axios'
import {
  PublicKey,
  Keypair,
  SystemProgram,
  Connection,
  sendAndConfirmTransaction,
  Transaction,
  TransactionInstruction
} from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { hexlify } from 'ethers';
import * as anchor from '@coral-xyz/anchor';
import { PIVY_STEALTH_IDL } from '../lib/pivy-stealth/IDL.js';
import { MESSAGE_TRANSMITTER_IDL, TOKEN_MESSENGER_IDL } from '../lib/cctp/IDL.js';
import { CHAINS } from '../config.js';
import { validateRequiredFields } from '../utils/validationUtils.js';
import { prismaQuery } from '../lib/prisma.js';
import { getOrCreateTokenCache } from '../utils/solanaUtils.js';
import { processPaymentTx } from '../workers/solana/helpers/activityHelpers.js';

const { Program, AnchorProvider, setProvider } = anchor;
const { BN } = anchor.default;

const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');

// Helper function to find program address
const findProgramAddress = (label, programId, extraSeeds = []) => {
  const seeds = [Buffer.from(label)];
  extraSeeds.forEach((seed) => {
    if (typeof seed === 'string') seeds.push(Buffer.from(seed));
    else if (Array.isArray(seed)) seeds.push(Buffer.from(seed));
    else if (Buffer.isBuffer(seed)) seeds.push(seed);
    else if (seed instanceof PublicKey) seeds.push(seed.toBuffer());
  });
  const [pubkey, bump] = PublicKey.findProgramAddressSync(seeds, programId);
  return { publicKey: pubkey, bump };
};

// Helper function to get PDAs for receive message
const getReceiveMessagePdas = async (
  messageTransmitterProgram,
  tokenMessengerMinterProgram,
  solUsdcAddress,
  remoteUsdcAddressHex,
  remoteDomain,
  nonce
) => {
  const tokenMessengerAccount = findProgramAddress('token_messenger', tokenMessengerMinterProgram.programId);
  const messageTransmitterAccount = findProgramAddress('message_transmitter', messageTransmitterProgram.programId);
  const tokenMinterAccount = findProgramAddress('token_minter', tokenMessengerMinterProgram.programId);
  const localToken = findProgramAddress('local_token', tokenMessengerMinterProgram.programId, [solUsdcAddress]);
  const remoteTokenMessengerKey = findProgramAddress('remote_token_messenger', tokenMessengerMinterProgram.programId, [remoteDomain]);
  const remoteTokenKey = new PublicKey(hexToBytes(remoteUsdcAddressHex));
  const tokenPair = findProgramAddress('token_pair', tokenMessengerMinterProgram.programId, [remoteDomain, remoteTokenKey]);
  const custodyTokenAccount = findProgramAddress('custody', tokenMessengerMinterProgram.programId, [solUsdcAddress]);
  const authorityPda = findProgramAddress('message_transmitter_authority', messageTransmitterProgram.programId, [tokenMessengerMinterProgram.programId]).publicKey;
  const tokenMessengerEventAuthority = findProgramAddress('__event_authority', tokenMessengerMinterProgram.programId);
  const usedNonces = await messageTransmitterProgram.methods
    .getNoncePda({
      nonce: new BN(nonce),
      sourceDomain: Number(remoteDomain)
    })
    .accounts({
      messageTransmitter: messageTransmitterAccount.publicKey,
    }).view();

  return {
    messageTransmitterAccount,
    tokenMessengerAccount,
    tokenMinterAccount,
    localToken,
    remoteTokenMessengerKey,
    remoteTokenKey,
    tokenPair,
    custodyTokenAccount,
    authorityPda,
    tokenMessengerEventAuthority,
    usedNonces
  };
};

// Helper function to convert hex to bytes
const hexToBytes = (hex) => Buffer.from(hex.replace(/^0x/, ''), 'hex');

// Helper function to poll for transaction confirmation
const pollForConfirmation = async (connection, signature, maxAttempts = 30) => {
  console.log("🔍 Polling for confirmation of signature:", signature);

  for (let i = 0; i < maxAttempts; i++) {
    try {
      // Use getSignatureStatuses RPC with searchTransactionHistory to avoid param errors
      const response = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
      const status = response.value[0];

      // If there's an error, immediately stop polling and throw
      if (status?.err) {
        const errorStr = JSON.stringify(status.err);
        console.error(`Transaction error detected:`, errorStr);
        throw new Error(`Transaction failed: ${errorStr}`);
      }

      if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') {
        console.log(`✅ Transaction confirmed (${status.confirmationStatus}) after ${i + 1} attempts`);
        return true;
      }

      // Wait 2 seconds between polling attempts
      await new Promise(resolve => setTimeout(resolve, 2000));
    } catch (error) {
      // If error contains "failed", immediately stop polling
      if (error.message.includes("failed") || error.message.includes("Custom")) {
        console.error(`❌ Transaction failed, stopping polling:`, error.message);
        throw error;
      }

      console.warn(`⚠️ Polling attempt ${i + 1} failed:`, error.message);

      // If it's the last attempt, throw the error
      if (i === maxAttempts - 1) {
        throw error;
      }

      // Wait before retrying
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
  throw new Error(`Transaction was not confirmed after ${maxAttempts} attempts`);
};

// Create connection with fallback options
const createRobustConnection = (endpoint, options = {}) => {
  // Disable WebSocket by default
  return new Connection(endpoint, {
    commitment: 'confirmed',
    confirmTransactionInitialTimeout: 60000,
    disableRetryOnRateLimit: false,
    httpHeaders: { 'Content-Type': 'application/json' },
    fetch: customFetch,
    ...options
  });
};

// Custom fetch function with timeout
const customFetch = async (url, options) => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 seconds timeout

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
};

// Helper function for transaction retry
const sendAndConfirmWithRetry = async (connection, transaction, signers, options = {}, maxRetries = 3) => {
  let lastError;
  for (let i = 0; i < maxRetries; i++) {
    try {
      // Get fresh blockhash before each attempt
      const latestBlockhash = await connection.getLatestBlockhash('confirmed');
      transaction.recentBlockhash = latestBlockhash.blockhash;
      transaction.feePayer = signers[0].publicKey;

      console.log(`🔄 Sending transaction attempt ${i + 1}/${maxRetries}`);

      // Send transaction
      const signature = await connection.sendTransaction(transaction, signers, {
        skipPreflight: true,
        ...options
      });

      console.log(`📤 Transaction sent, signature: ${signature}`);

      // Poll for confirmation instead of using WebSocket
      await pollForConfirmation(connection, signature);

      return signature;
    } catch (error) {
      console.error(`❌ Transaction attempt ${i + 1} failed:`, error.message);

      // If error is related to a custom program error, stop retrying
      if (error.message.includes("Custom")) {
        console.error(`Program error detected, stopping retry:`, error.message);
        throw error;
      }

      lastError = error;

      // Wait before retrying
      await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
    }
  }
  throw new Error(`Transaction failed after ${maxRetries} attempts: ${lastError.message}`);
};

// Helper function to verify token balance
const verifyTokenBalance = async (connection, tokenAccount, expectedAmount) => {
  try {
    const balance = await connection.getTokenAccountBalance(tokenAccount);
    const actualAmount = new BN(balance.value.amount);
    const expected = new BN(expectedAmount);

    if (actualAmount.lt(expected)) {
      throw new Error(`Token balance verification failed. Expected: ${expected.toString()}, Actual: ${actualAmount.toString()}`);
    }
    return balance.value;
  } catch (error) {
    console.error('Error verifying token balance:', error);
    throw error;
  }
};

/**
 * CCTP Routes
 * @param {import("fastify").FastifyInstance} app
 * @param {*} _
 * @param {Function} done
 */
export const cctpRoutes = (app, _, done) => {
  app.post('/process-cctp-tx', async (request, reply) => {
    try {
      // Validate required fields
      const requiredFields = [
        'srcDomain',
        'srcTxHash',
        'amount',
        'stealthAta',
        'stealthOwnerPub',
        'attestation',
        'usdcAddress',
        'tokenMessengerMinterProgramInfo',
        'tokenTransmitterProgramInfo',
        'encryptedPayload',
        'linkId',
        'ephPub'
      ];

      const validationResult = await validateRequiredFields(request.body, requiredFields, reply);
      if (validationResult !== true) {
        return validationResult;
      }

      const {
        srcDomain,
        srcTxHash,
        amount,
        stealthAta,
        stealthOwnerPub,
        attestation,
        usdcAddress,
        tokenMessengerMinterProgramInfo,
        tokenTransmitterProgramInfo,
        encryptedPayload,
        linkId,
        ephPub,
        chain = 'DEVNET'
      } = request.body;

      // Validate program info structures
      if (!tokenMessengerMinterProgramInfo.address || !tokenMessengerMinterProgramInfo.domain) {
        return reply.code(400).send({
          error: 'Invalid tokenMessengerMinterProgramInfo structure'
        });
      }

      if (!tokenTransmitterProgramInfo.address || !tokenTransmitterProgramInfo.domain) {
        return reply.code(400).send({
          error: 'Invalid tokenTransmitterProgramInfo structure'
        });
      }

      // Get link details for label
      const link = await prismaQuery.link.findUnique({
        where: { id: linkId }
      });

      if (!link) {
        return reply.code(404).send({
          error: 'Link not found'
        });
      }

      // Set up connection and provider
      const chainConfig = CHAINS[chain];
      console.log("🔍 Chain config:", chainConfig);
      if (!chainConfig) {
        return reply.code(400).send({
          error: 'Invalid chain specified'
        });
      }

      // Initialize fee payer
      const feePayer = Keypair.fromSecretKey(bs58.decode(process.env.SOLANA_FEE_PAYER_PK));

      // Create connection without WebSocket
      const connection = createRobustConnection(chainConfig.heliusRpcUrl);

      const provider = new AnchorProvider(
        connection,
        {
          publicKey: feePayer.publicKey,
          signTransaction: async (tx) => {
            tx.partialSign(feePayer);
            return tx;
          },
          signAllTransactions: async (txs) => {
            return txs.map(tx => {
              tx.partialSign(feePayer);
              return tx;
            });
          },
        },
        { commitment: 'confirmed' }
      );
      setProvider(provider);

      // Get the USDC mint address based on chain
      const usdcMint = new PublicKey(chain === 'MAINNET'
        ? 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'  // Mainnet USDC
        : '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'  // Devnet USDC
      );

      // Initialize programs
      const messageTransmitterProgram = new Program(
        MESSAGE_TRANSMITTER_IDL,
        new PublicKey(tokenTransmitterProgramInfo.address),
        provider
      );

      const tokenMessengerMinterProgram = new Program(
        TOKEN_MESSENGER_IDL,
        new PublicKey(tokenMessengerMinterProgramInfo.address),
        provider
      );

      const pivyProgram = new Program(
        PIVY_STEALTH_IDL,
        new PublicKey(chainConfig.pivyStealthProgramId),
        provider
      );

      // Get PDAs for receive message
      const pdas = await getReceiveMessagePdas(
        messageTransmitterProgram,
        tokenMessengerMinterProgram,
        usdcMint,  // Use USDC mint address
        usdcAddress,
        srcDomain.toString(),
        attestation.eventNonce
      );

      // Prepare account metas for token messenger program
      const accountMetas = [
        { pubkey: pdas.tokenMessengerAccount.publicKey, isWritable: false, isSigner: false },
        { pubkey: pdas.remoteTokenMessengerKey.publicKey, isWritable: false, isSigner: false },
        { pubkey: pdas.tokenMinterAccount.publicKey, isWritable: true, isSigner: false },
        { pubkey: pdas.localToken.publicKey, isWritable: true, isSigner: false },
        { pubkey: pdas.tokenPair.publicKey, isWritable: false, isSigner: false },
        { pubkey: new PublicKey(stealthAta), isWritable: true, isSigner: false },
        { pubkey: pdas.custodyTokenAccount.publicKey, isWritable: true, isSigner: false },
        { pubkey: TOKEN_PROGRAM_ID, isWritable: false, isSigner: false },
        { pubkey: pdas.tokenMessengerEventAuthority.publicKey, isWritable: false, isSigner: false },
        { pubkey: tokenMessengerMinterProgram.programId, isWritable: false, isSigner: false },
      ];

      // Build receive message instruction
      const receiveMessageIx = await messageTransmitterProgram.methods
        .receiveMessage({
          message: Buffer.from(attestation.message.replace(/^0x/, ''), 'hex'),
          attestation: Buffer.from(attestation.attestation.replace(/^0x/, ''), 'hex'),
        })
        .accounts({
          payer: provider.publicKey,
          caller: provider.publicKey,
          authorityPda: pdas.authorityPda,
          messageTransmitter: pdas.messageTransmitterAccount.publicKey,
          usedNonces: pdas.usedNonces,
          receiver: tokenMessengerMinterProgram.programId,
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts(accountMetas)
        .instruction();

      // Check if ATA exists, if not create it
      const stealthAtaPubkey = new PublicKey(stealthAta);
      const stealthOwnerPubkey = new PublicKey(stealthOwnerPub);

      let ataExists = false;
      try {
        await connection.getTokenAccountBalance(stealthAtaPubkey);
        ataExists = true;
      } catch (error) {
        const createAtaIx = createAssociatedTokenAccountInstruction(
          provider.publicKey,
          stealthAtaPubkey,
          stealthOwnerPubkey,
          usdcMint
        );

        const createAtaTx = new Transaction().add(createAtaIx);
        createAtaTx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
        createAtaTx.feePayer = provider.publicKey;

        const createAtaSig = await sendAndConfirmTransaction(connection, createAtaTx, [feePayer]);
        console.log('\n📝 Created ATA:', createAtaSig);
      }

      // Log before receive message transaction
      console.log('\n📝 CCTP Receive:', receiveMessageIx);

      const receiveTx = new Transaction();
      receiveTx.add(receiveMessageIx);

      const receiveSig = await sendAndConfirmWithRetry(
        connection,
        receiveTx,
        [feePayer],
        {
          commitment: 'confirmed',
          skipPreflight: true
        }
      );

      console.log('\n📝 CCTP Receive:', receiveSig);
      console.log(`https://explorer.solana.com/tx/${receiveSig}${chain === 'DEVNET' ? '?cluster=devnet' : ''}`);

      // Get intermediate balance
      const midBalance = await verifyTokenBalance(
        connection,
        new PublicKey(stealthAta),
        amount
      );
      console.log('\n📝 Balance:', midBalance.uiAmount);

      // Build memo instruction
      const memoIx = new TransactionInstruction({
        keys: [],
        programId: MEMO_PROGRAM_ID,
        data: Buffer.from(encryptedPayload, 'utf8')
      });

      // Build announce instruction
      const labelBuf = Buffer.alloc(32);
      labelBuf.write(link.label);

      const announceIx = await pivyProgram.methods
        .announce({
          amount: new BN(midBalance.amount),  // Use actual received amount
          label: [...labelBuf],
          ephPubkey: new PublicKey(stealthOwnerPub),
        })
        .accounts({
          stealthOwner: new PublicKey(stealthOwnerPub),
          payer: provider.publicKey,
          mint: usdcMint,
        })
        .instruction();

      // Second transaction - memo and announce
      const announceTx = new Transaction();
      announceTx.add(memoIx).add(announceIx);

      // Log before announce transaction
      console.log('\n📝 CCTP Announce:', announceIx);

      const announceSig = await sendAndConfirmWithRetry(
        connection,
        announceTx,
        [feePayer],
        {
          commitment: 'confirmed',
          skipPreflight: true
        }
      );

      console.log('\n📝 Announce:', announceSig);
      console.log(`https://explorer.solana.com/tx/${announceSig}${chain === 'DEVNET' ? '?cluster=devnet' : ''}`);

      // Get memo from signature info
      let txMemo = encryptedPayload; // fallback
      try {
        const signatures = await connection.getSignaturesForAddress(
          new PublicKey(chainConfig.pivyStealthProgramId),
          { limit: 1 }
        );
        if (signatures[0]?.memo) {
          txMemo = signatures[0].memo;
        }
      } catch (memoErr) {
        console.warn('Unable to get memo from signature, using fallback.');
      }

      // =============================
      // Save Payment record directly
      // =============================
      try {
        // Fetch transaction details for slot & timestamp
        const txInfo = await connection.getTransaction(announceSig, {
          commitment: 'confirmed',
          maxSupportedTransactionVersion: 0
        });

        const slot = txInfo?.slot || 0;
        const timestamp = txInfo?.blockTime || Math.floor(Date.now() / 1000);

        // Ensure token cache exists for USDC
        const tokenCache = await getOrCreateTokenCache(
          usdcMint.toBase58(),
          chainConfig.id,
          connection
        );

        // Create Payment entry (ignore if already exists)
        const newPayment = await prismaQuery.payment.upsert({
          where: {
            txHash: announceSig
          },
          update: {},
          create: {
            txHash: announceSig,
            slot: slot,
            timestamp: timestamp,
            stealthOwnerPubkey: stealthOwnerPub,
            ephemeralPubkey: ephPub,
            payerPubKey: provider.publicKey.toBase58(),
            amount: midBalance.amount.toString(),
            label: link.label,
            memo: txMemo,
            announce: true,
            chain: chainConfig.id,
            link: {
              connect: { id: link.id }
            },
            mint: {
              connect: { id: tokenCache.id }
            }
          }
        }).catch(err => {
          console.error("Error saving payment: ", err)
        });

        console.log("Processing payment tx: ", announceSig)
        await processPaymentTx({
          txHash: announceSig
        })

        console.log('\n📝 Payment saved:', announceSig);
      } catch (saveErr) {
        console.error('Error saving Payment:', saveErr.message);
      }

      return reply.send({
        receiveSignature: receiveSig,
        announceSignature: announceSig,
        message: 'CCTP transfer completed successfully',
        explorerUrls: {
          receive: `https://explorer.solana.com/tx/${receiveSig}${chain === 'DEVNET' ? '?cluster=devnet' : ''}`,
          announce: `https://explorer.solana.com/tx/${announceSig}${chain === 'DEVNET' ? '?cluster=devnet' : ''}`
        }
      });

    } catch (error) {
      console.error('\n❌ CCTP Error:', error.message);

      return reply.code(500).send({
        error: 'CCTP transfer failed',
        details: error.message,
        logs: error.logs || []
      });
    }
  });

  done();
}