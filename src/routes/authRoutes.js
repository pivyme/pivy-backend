import { Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { prismaQuery } from "../lib/prisma.js";
import bs58 from "bs58";
import { SIWS } from "@web3auth/sign-in-with-solana";
import jwt from "jsonwebtoken";
import { authMiddleware } from "../middlewares/authMiddleware.js";
import { CHAINS, WALLET_CHAINS } from "../config.js";
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { verifyPersonalMessageSignature } from '@mysten/sui/verify';
import { getPrivBytes, getPubBytes } from "../lib/pivy-stealth/pivy-stealth-sui.js";
import { TOKEN_PROGRAM_ID } from "@coral-xyz/anchor/dist/cjs/utils/token.js";
import * as solanaWeb3 from "@solana/web3.js";
import * as splToken from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";

/**
 * Airdrops test tokens (0.2 SOL and 100 USDC) to a new user on Solana devnet
 * @param {string} userAddress - The user's wallet address
 * @returns {Promise<void>}
 */
export async function handleAirdropTestSolanaTokens(userAddress) {
  // Only airdrop on devnet
  if (process.env.CHAIN === 'MAINNET') {
    return;
  }

  const connection = new solanaWeb3.Connection(CHAINS[process.env.CHAIN || 'DEVNET'].heliusRpcUrl, "confirmed");
  const feePayer = Keypair.fromSecretKey(bs58.decode(process.env.SOLANA_FEE_PAYER_PK));
  
  // Get USDC mint based on chain
  const usdcMint = new PublicKey(process.env.CHAIN === 'MAINNET'
    ? 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'  // Mainnet USDC
    : '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'  // Devnet USDC
  );

  // First send SOL
  const solTransfer = solanaWeb3.SystemProgram.transfer({
    fromPubkey: feePayer.publicKey,
    toPubkey: new PublicKey(userAddress),
    lamports: 0.2 * LAMPORTS_PER_SOL
  });

  // Get or create user's USDC token account
  const userAta = await splToken.getAssociatedTokenAddress(
    usdcMint,
    new PublicKey(userAddress)
  );

  // Check if user's token account exists
  const userAtaInfo = await connection.getAccountInfo(userAta);
  
  let tx = new solanaWeb3.Transaction();
  tx.add(solTransfer);

  // If token account doesn't exist, create it
  if (!userAtaInfo) {
    tx.add(
      splToken.createAssociatedTokenAccountInstruction(
        feePayer.publicKey,
        userAta,
        new PublicKey(userAddress),
        usdcMint
      )
    );
  }

  // Get fee payer's USDC token account
  const feePayerAta = await splToken.getAssociatedTokenAddress(
    usdcMint,
    feePayer.publicKey
  );

  // Transfer 100 USDC
  tx.add(
    splToken.createTransferInstruction(
      feePayerAta,
      userAta,
      feePayer.publicKey,
      100_000_000 // 100 USDC (6 decimals)
    )
  );

  // Send and confirm transaction
  try {
    const signature = await connection.sendTransaction(tx, [feePayer]);
    await connection.confirmTransaction(signature, "confirmed");
    console.log('Airdrop successful:', signature);
  } catch (error) {
    console.error('Error sending airdrop:', error);
    // Continue with login even if airdrop fails
  }
}

/**
 *
 * @param {import("fastify").FastifyInstance} app
 * @param {*} _
 * @param {Function} done
 */
export const authRoutes = (app, _, done) => {
  app.post('/login', async (req, res) => {
    try {
      const { walletChain } = req.body;

      if (walletChain === WALLET_CHAINS.SOLANA.id) {
        const { signature, publicKey, payload, header } = req.body;

        if (!signature || !publicKey || !payload || !header) {
          return res.status(400).send({
            message: "Missing required fields",
            error: "Invalid request",
            data: null,
          });
        }

        const base58Signature = bs58.encode(Buffer.from(signature.s, 'base64'));

        const _signature = {
          t: header.t,
          s: base58Signature
        }

        const SiwsObject = new SIWS({ header, payload });
        const verificationResult = await SiwsObject.verify({ payload, signature: _signature });

        if (!verificationResult.success) {
          return res.status(401).send({
            message: "Invalid signature",
            error: "Authentication failed",
            data: null,
          });
        }

        const userAddress = verificationResult.data.payload.address;
        // Search current user
        let user = await prismaQuery.user.findUnique({
          where: {
            walletAddress: userAddress,
            walletChain: 'SOLANA'
          }
        })

        // If user not found, create a new user
        if (!user) {
          user = await prismaQuery.user.create({
            data: {
              walletAddress: userAddress,
              walletChain: WALLET_CHAINS.SOLANA.id,
              links: {
                create: {
                  tag: ``,
                  label: "personal",
                  type: 'SIMPLE',
                  amountType: 'OPEN'
                }
              }
            }
          })

          // Airdrop test tokens to new users
          await handleAirdropTestSolanaTokens(userAddress);
        }

        // Create jwt token
        const token = jwt.sign({
          ...user,
        }, process.env.JWT_SECRET, {
          expiresIn: '30d'
        })

        return res.status(200).send(token);
      } else if (walletChain === WALLET_CHAINS.SUI.id) {
        const { publicKey, message, signature } = req.body;

        if (!publicKey || !signature || !message) {
          return res.status(400).send({
            message: "Missing required fields",
            error: "Invalid request",
            data: null,
          });
        }

        try {
          console.log('Signature verification started', {
            message,
            signature,
            publicKey
          });
          // Convert hex public key (remove 0x prefix and convert to bytes)
          await verifyPersonalMessageSignature(
            new TextEncoder().encode(message),
            signature.signature,
            {
              address: publicKey
            }
          )
          console.log('Signature verified successfully');

          let user = await prismaQuery.user.findUnique({
            where: {
              walletAddress: publicKey,
              walletChain: 'SUI'
            }
          })

          // If user not found, create a new user
          if (!user) {
            user = await prismaQuery.user.create({
              data: {
                walletAddress: publicKey,
                walletChain: WALLET_CHAINS.SUI.id,
                links: {
                  create: {
                    tag: ``,
                    label: "personal",
                    type: 'SIMPLE',
                    amountType: 'OPEN'
                  }
                }
              }
            })
          }

          // Create jwt token
          const token = jwt.sign({
            ...user,
          }, process.env.JWT_SECRET, {
            expiresIn: '30d'
          })

          return res.status(200).send(token);
        } catch (error) {
          console.error('Error in SUI signature verification:', error);
          return res.status(401).send({
            message: "Error verifying signature",
            error: error.message,
            data: null,
          });
        }
      } else {
        return res.status(400).send({
          message: "Invalid wallet chain",
          error: "Invalid request",
          data: null,
        });
      }
    } catch (error) {
      console.log('error in login route', error);
      return res.status(500).send({
        message: 'Internal server error',
        error: error.message,
        data: null
      })
    }
  })

  app.post('/register-meta-keys', {
    preHandler: [authMiddleware]
  }, async (request, reply) => {
    const { metaSpendPub, metaViewPub, metaViewPriv } = request.body;

    const user = await prismaQuery.user.update({
      where: {
        id: request.user.id
      },
      data: {
        metaSpendPub,
        metaViewPub,
        metaViewPriv
      }
    })

    return reply.status(200).send(user);
  })

  app.get('/me', {
    preHandler: [authMiddleware]
  }, async (request, reply) => {
    try {
      const user = await prismaQuery.user.findUnique({
        where: {
          id: request.user.id
        }
      })

      return reply.status(200).send(user);
    } catch (error) {
      console.log('Error getting user', error);
      return reply.status(500).send({
        message: "Error getting user",
        error: error.message,
        data: null,
      });
    }
  })

  done();
}

