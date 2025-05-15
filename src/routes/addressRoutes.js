import { prismaQuery } from "../lib/prisma.js";
import bs58 from "bs58";
import * as ed from "@noble/ed25519";
import { Keypair } from "@solana/web3.js";

/**
 *
 * @param {import("fastify").FastifyInstance} app
 * @param {*} _
 * @param {Function} done
 */
export const addressRoutes = (app, _, done) => {
  app.get('/:username/:tag', async (request, reply) => {
    try {
      const { username } = request.params;
      const tag = request.params.tag ?? "";

      const user = await prismaQuery.user.findUnique({
        where: {
          username: username
        },
        include: {
          links: {
            include: {
              file: {
                select: {
                  id: true,
                  filename: true,
                  size: true,
                }
              },
              mint: true // Include mint data directly
            }
          }
        }
      })

      if (!user) {
        return reply.status(404).send({
          message: "User not found",
          error: "User not found",
          data: null,
        });
      }

      const link = user.links.find(link => link.tag === tag);

      if (!link) {
        return reply.status(404).send({
          message: "Link not found",
          error: "Link not found",
          data: null,
        });
      }

      // expose ONLY the public pieces
      const spendScalar = Buffer.from(user.metaSpendPriv, "hex");
      const viewScalar = Buffer.from(user.metaViewPriv, "hex");
      const metaSpendPub = bs58.encode(await ed.getPublicKey(spendScalar));
      const metaViewPub = bs58.encode(await ed.getPublicKey(viewScalar));

      // Format the link data
      const linkData = {
        ...link,
        amount: link.amount,
        chainAmount: link.amount && link.mint ? 
          BigInt(link.amount * (10 ** link.mint.decimals)).toString() : 
          null
      };

      const data = {
        username: user.username,
        tag: link.tag,
        metaSpendPub: metaSpendPub,
        metaViewPub: metaViewPub,
        linkData: linkData
      }

      return reply.status(200).send(data);
    } catch (error) {
      console.log('Error getting address', error);
      return reply.status(500).send({
        message: "Error getting address",
        error: error.message,
        data: null,
      });
    }
  })

  done();
}