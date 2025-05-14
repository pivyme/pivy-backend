import { Keypair } from "@solana/web3.js";
import { prismaQuery } from "../lib/prisma.js";
import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes/index";

/**
 *
 * @param {import("fastify").FastifyInstance} app
 * @param {*} _
 * @param {Function} done
 */
export const exampletRoute = (app, _, done) => {
  app.post('/login', async (req, res) => {

    // On new user
    const handleCreateUser = async () => {
      const spendKey = Keypair.generate();
      const viewKey = Keypair.generate();

      await prismaQuery.user.create({
        data: {
          // walletAddress: ...,
          metaSpendPriv: Buffer.from(spendKey.secretKey.slice(0, 32)).toString("hex"),
          metaViewPriv : Buffer.from(viewKey.secretKey.slice(0, 32)).toString("hex"),
        }
      })
    }
  })

  done();
}