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
import axios from "axios";
// Sui imports
import { SuiClient } from "@mysten/sui/client";
import { Transaction } from '@mysten/sui/transactions';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';

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
 * Airdrops test tokens (0.05 SUI and 100 USDC) to a new user on Sui testnet
 * @param {string} userAddress - The user's wallet address
 * @returns {Promise<void>}
 */
export async function handleAirdropTestSuiTokens(userAddress) {
  // Only airdrop on testnet
  if (process.env.CHAIN === 'MAINNET') {
    return;
  }

  try {
    const chain = CHAINS.SUI_TESTNET;
    const client = new SuiClient({ url: chain.rpcUrl });
    const signer = Ed25519Keypair.fromSecretKey(decodeSuiPrivateKey(process.env.SUI_FEE_PAYER_PK).secretKey);
    
    // USDC token type for Sui testnet
    const usdcType = '0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC';
    
    // Create transaction
    const tx = new Transaction();
    
    // Transfer 0.05 SUI (50,000,000 MIST as SUI has 9 decimals)
    const [suiCoin] = tx.splitCoins(tx.gas, [50_000_000]);
    tx.transferObjects([suiCoin], userAddress);
    
    // Transfer 100 USDC (100,000,000 units as USDC has 6 decimals)
    const usdcCoins = await client.getCoins({
      owner: signer.toSuiAddress(),
      coinType: usdcType,
    });
    
    if (usdcCoins.data.length > 0) {
      // Find a coin with enough balance or merge coins if needed
      let totalBalance = 0;
      const coinsToMerge = [];
      
      for (const coin of usdcCoins.data) {
        totalBalance += parseInt(coin.balance);
        coinsToMerge.push(coin.coinObjectId);
        if (totalBalance >= 100_000_000) break;
      }
      
      if (totalBalance >= 100_000_000) {
        // If we have multiple coins, merge them first
        if (coinsToMerge.length > 1) {
          tx.mergeCoins(coinsToMerge[0], coinsToMerge.slice(1));
        }
        
        // Split the required amount and transfer
        const [usdcCoin] = tx.splitCoins(coinsToMerge[0], [100_000_000]);
        tx.transferObjects([usdcCoin], userAddress);
      }
    }
    
    // Set gas budget
    tx.setGasBudget(10_000_000);
    
    // Execute transaction
    const result = await client.signAndExecuteTransaction({
      signer,
      transaction: tx,
    });
    
    // Wait for confirmation
    await client.waitForTransaction({
      digest: result.digest,
      options: {
        showEffects: true,
      },
    });
    
    console.log('Sui airdrop successful:', result.digest);
  } catch (error) {
    console.error('Error sending Sui airdrop:', error);
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

      if (walletChain === WALLET_CHAINS.SUI_ZKLOGIN.id) {
        const { jwt: openIdJwt, walletAddress } = req.body;

        if (!openIdJwt || !walletAddress) {
          return res.status(400).send({
            message: "Missing required fields: jwt and walletAddress",
            error: "Invalid request",
            data: null,
          });
        }

        try {
          // Verify the JWT is valid (basic check - you might want more robust validation)
          const jwtPayload = JSON.parse(Buffer.from(openIdJwt.split('.')[1], 'base64').toString());
          
          // Check if JWT is expired
          if (jwtPayload.exp && jwtPayload.exp < Date.now() / 1000) {
            return res.status(401).send({
              message: "JWT token has expired",
              error: "Authentication failed",
              data: null,
            });
          }

          // Search current user by zkLogin wallet address
          let user = await prismaQuery.user.findUnique({
            where: {
              walletAddress: walletAddress,
              walletChain: 'SUI_ZKLOGIN'
            }
          });

          // If user not found, create a new user
          if (!user) {
            user = await prismaQuery.user.create({
              data: {
                walletAddress: walletAddress,
                walletChain: 'SUI_ZKLOGIN',
                links: {
                  create: {
                    tag: ``,
                    label: "personal",
                    type: 'SIMPLE',
                    amountType: 'OPEN'
                  }
                }
              }
            });

            // Airdrop test tokens to new users (using Sui testnet)
            await handleAirdropTestSuiTokens(walletAddress);
          }

          // Create jwt token for your app
          const token = jwt.sign({
            ...user,
          }, process.env.JWT_SECRET, {
            expiresIn: '30d'
          });

          return res.status(200).send(token);
        } catch (error) {
          console.error('Error in zkLogin authentication:', error);
          return res.status(401).send({
            message: "Error verifying zkLogin authentication",
            error: error.message,
            data: null,
          });
        }
      } else if (walletChain === WALLET_CHAINS.SOLANA.id) {
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

            // Airdrop test tokens to new users
            await handleAirdropTestSuiTokens(publicKey);
          }

          // Create jwt token
          const token = jwt.sign({
            ...user,
          }, process.env.JWT_SECRET, {
            expiresIn: '30d'
          })

          return res.status(200).send(token);
        } catch (error) {
          console.log('Error in SUI signature verification:', error);
          return res.status(401).send({
            message: "Error verifying signature",
            error: error.message,
            data: null,
          });
        }
      } else {
        console.log('Invalid wallet chain', walletChain);
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

  app.post('/zklogin', async (request, reply) => {
    try {
      const { signedJWTToken } = request.body;

      if (!signedJWTToken) {
        return reply.status(400).send({
          message: "Missing required field: signedJWTToken",
          error: "Invalid request",
          data: null,
        });
      }

      const response = await axios.post('https://api.us1.shinami.com/sui/zkwallet/v1', {
        jsonrpc: "2.0",
        method: "shinami_zkw_getOrCreateZkLoginWallet",
        params: [signedJWTToken],
        id: 1
      }, {
        headers: {
          'X-API-Key': process.env.SHINAMI_API_KEY,
          'Content-Type': 'application/json'
        }
      });

      return reply.status(200).send(response.data);
    } catch (error) {
      console.log('Error in zklogin route', error);
      return reply.status(500).send({
        message: 'Error calling Shinami zklogin API',
        error: error.response?.data || error.message,
        data: null
      });
    }
  })

  app.post('/zkproof', async (request, reply) => {
    try {
      const { 
        jwt, 
        maxEpoch, 
        extendedEphemeralPublicKey, 
        jwtRandomness, 
        salt, 
        keyClaimName 
      } = request.body;

      // Validate required fields
      if (!jwt || !maxEpoch || !extendedEphemeralPublicKey || !jwtRandomness || !salt) {
        return reply.status(400).send({
          message: "Missing required fields: jwt, maxEpoch, extendedEphemeralPublicKey, jwtRandomness, salt",
          error: "Invalid request",
          data: null,
        });
      }

      // Build params array - keyClaimName is optional
      const params = [jwt, maxEpoch, extendedEphemeralPublicKey, jwtRandomness, salt];
      if (keyClaimName) {
        params.push(keyClaimName);
      }

      const response = await axios.post('https://api.us1.shinami.com/sui/zkprover/v1', {
        jsonrpc: "2.0",
        method: "shinami_zkp_createZkLoginProof",
        params: params,
        id: 1
      }, {
        headers: {
          'X-API-Key': process.env.SHINAMI_API_KEY,
          'Content-Type': 'application/json'
        }
      });

      return reply.status(200).send(response.data);
    } catch (error) {
      console.log('Error in zkproof route', error);
      return reply.status(500).send({
        message: 'Error calling Shinami zkproof API',
        error: error.response?.data || error.message,
        data: null
      });
    }
  })

  done();
}

