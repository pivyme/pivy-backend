import { prismaQuery } from "../lib/prisma.js";
import bs58 from "bs58";
import * as ed from "@noble/ed25519";
import { Keypair } from "@solana/web3.js";
import { authMiddleware } from "../middlewares/authMiddleware.js";

// View count throttle cache - tracks last view increment time for each link
const viewCountThrottleCache = new Map();
const THROTTLE_DURATION = 3 * 1000; // 3 seconds in milliseconds

/**
 * Check if view count can be incremented for a given link
 * @param {string} linkId - The link ID to check
 * @returns {boolean} - True if view count can be incremented, false otherwise
 */
const canIncrementViewCount = (linkId) => {
  const lastIncrementTime = viewCountThrottleCache.get(linkId);
  const now = Date.now();
  
  if (!lastIncrementTime || (now - lastIncrementTime) >= THROTTLE_DURATION) {
    viewCountThrottleCache.set(linkId, now);
    return true;
  }
  
  return false;
};

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
      const metaSpendPub = user.metaSpendPub
      const metaViewPub = user.metaViewPub

      // Format the link data
      const linkData = {
        ...link,
        amount: link.amount,
        chainAmount: link.amount && link.mint ?
          BigInt(link.amount * (10 ** link.mint.decimals)).toString() :
          null
      };

      let sourceChain = user.walletChain;
      if (user.walletChain === 'SUI_ZKLOGIN') {
        sourceChain = 'SUI';
      }

      const data = {
        username: user.username,
        tag: link.tag,
        metaSpendPub: metaSpendPub,
        metaViewPub: metaViewPub,
        linkData: linkData,
        sourceChain: sourceChain
      }

      // Only increment view count if throttle allows it (max once per 3 seconds)
      if (canIncrementViewCount(link.id)) {
        console.log('Incrementing view count for link', link.id);
        await prismaQuery.link.update({
          where: {
            id: link.id
          },
          data: {
            viewCount: { increment: 1 }
          }
        });
      } else {
        console.log('Skipping view count increment for link', link.id);
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