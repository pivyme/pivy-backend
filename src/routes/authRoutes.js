import { Keypair } from "@solana/web3.js";
import { prismaQuery } from "../lib/prisma.js";
import bs58 from "bs58";
import { SIWS } from "@web3auth/sign-in-with-solana";
import jwt from "jsonwebtoken";
import { authMiddleware } from "../middlewares/authMiddleware.js";

/**
 *
 * @param {import("fastify").FastifyInstance} app
 * @param {*} _
 * @param {Function} done
 */
export const authRoutes = (app, _, done) => {
  app.post('/login', async (req, res) => {
    try {
      const { signature, publicKey, payload, header } = req.body;
      console.log('body', req.body);

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
      console.log('signature', _signature);

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
          walletAddress: userAddress
        }
      })

      // If user not found, create a new user
      if (!user) {
        const spendKey = Keypair.generate();
        const viewKey = Keypair.generate();

        user = await prismaQuery.user.create({
          data: {
            walletAddress: userAddress,
            metaSpendPriv: Buffer.from(spendKey.secretKey.slice(0, 32)).toString("hex"),
            metaViewPriv: Buffer.from(viewKey.secretKey.slice(0, 32)).toString("hex"),
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
      console.log('error in login route', error);
      return res.status(500).send({
        message: 'Internal server error',
        error: error.message,
        data: null
      })
    }
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

