import { Connection } from "@solana/web3.js";
import { CHAINS } from "../config.js";
import { prismaQuery } from "../lib/prisma.js";
import { authMiddleware } from "../middlewares/authMiddleware.js";
import multipart from '@fastify/multipart';
import { getTokenInfo } from "../utils/solanaUtils.js";

/**
 *
 * @param {import("fastify").FastifyInstance} app
 * @param {*} _
 * @param {Function} done
 */
export const linkRoutes = (app, _, done) => {
  app.post('/create-link', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    try {
      const { chain = 'DEVNET' } = request.query;

      // Extract data from request.body
      const data = {
        type: request.body.type.value,
        name: request.body.name.value,
        slug: request.body.slug.value,
        amountType: request.body.amountType.value,
        description: request.body.description?.value,
        emoji: request.body.emoji?.value,
        backgroundColor: request.body.backgroundColor?.value,
      };

      // Handle file if present
      let fileData = null;
      if (request.body.file && request.body.file.type === 'file') {
        fileData = {
          filename: request.body.file.filename,
          mimetype: request.body.file.mimetype,
          buffer: await request.body.file.toBuffer()
        };
      }

      console.log('Processed form data:', data);

      // Generate slug from name
      const slug = data.slug;

      // Base link data that's common for all types
      const baseLinkData = {
        userId: request.user.id,
        tag: slug,
        label: data.name,
        type: data.type.toUpperCase(),
        emoji: data.emoji,
        backgroundColor: data.backgroundColor,
        description: data.description,
      };

      let link;

      // Handle token info if needed
      if (data.amountType === 'fixed') {
        const token = JSON.parse(request.body.token.value);
        const tokenInfo = await getOrCreateTokenInfo(chain, token);
        baseLinkData.amountType = 'FIXED';
        // Store the human readable amount directly
        baseLinkData.amount = Number(request.body.amount.value);
        baseLinkData.mint = {
          connect: {
            id: tokenInfo.id
          }
        };
      } else {
        baseLinkData.amountType = 'OPEN';
      }

      // Create the link with file if it's a download type
      if (data.type === 'download' && fileData) {
        link = await prismaQuery.link.create({
          data: {
            ...baseLinkData,
            file: {
              create: {
                filename: fileData.filename,
                mimetype: fileData.mimetype,
                size: fileData.buffer.length,
                data: fileData.buffer
              }
            }
          },
          include: {
            file: true,
            mint: true
          }
        });
      } else {
        link = await prismaQuery.link.create({
          data: baseLinkData,
          include: {
            mint: true
          }
        });
      }

      // Remove the file buffer from the response
      if (link.file) {
        link.file = {
          ...link.file,
          data: undefined // Don't send the file data in response
        };
      }

      // Format the response to include both UI and chain amounts
      const responseLink = {
        ...link,
        amount: link.amount, // Already in human readable format
        chainAmount: link.amount && link.mint ? 
          BigInt(link.amount * (10 ** link.mint.decimals)).toString() : 
          null
      };

      return reply.status(200).send({
        message: "Link created successfully",
        data: responseLink
      });
    } catch (error) {
      console.log('Error creating link', error);

      // Handle specific file size error
      if (error.code === 'FST_REQ_FILE_TOO_LARGE') {
        return reply.status(413).send({
          message: "File size too large",
          error: "Maximum file size is 5MB",
          data: null
        });
      }

      return reply.status(500).send({
        message: "Error creating link",
        error: error.message,
        data: null
      });
    }
  });

  app.get('/my-links', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    try {
      const links = await prismaQuery.link.findMany({
        where: {
          userId: request.user.id,
        },
        include: {
          file: {
            select: {
              id: true,
              filename: true,
              size: true,
            }
          },
          mint: true,
          user: {
            select: {
              username: true,
            }
          }
        },
        orderBy: {
          createdAt: 'desc'
        }
      });

      const linkObjects = links.map(link => {
        let linkPreview = link.tag === "" 
          ? `pivy.me/${link.user.username}`
          : `pivy.me/${link.user.username}/${link.tag}`;

        return {
          ...link,
          linkPreview,
          // Amount is already in human readable format
          amount: link.amount,
          // Add chain amount if fixed amount type
          chainAmount: link.amount && link.mint ? 
            BigInt(link.amount * (10 ** link.mint.decimals)).toString() : 
            null
        };
      });

      return reply.status(200).send(linkObjects);
    } catch (error) {
      console.error('Error fetching links:', error);
      return reply.status(500).send({
        message: "Error fetching links",
        error: error.message,
        data: null
      });
    }
  });

  // Fetch file
  app.get('/file/:id', async (request, reply) => {
    try {
      const { id } = request.params;
      console.log('Fetching file', id);
      const file = await prismaQuery.file.findUnique({
        where: { id }
      });

      if (!file) {
        return reply.status(404).send({
          message: "File not found",
          error: "File not found",
          data: null
        });
      }

      // Set the appropriate headers for file download
      reply.header('Content-Type', file.mimetype);
      reply.header('Content-Disposition', `attachment; filename="${file.filename}"`);
      reply.header('Content-Length', file.size);

      // Send the file data
      return reply.send(file.data);
    } catch (error) {
      console.log('Error fetching file', error);
      return reply.status(500).send({
        message: "Error fetching file",
        error: error.message,
        data: null
      });
    }
  });

  done();
}

// Helper function to get or create token info
async function getOrCreateTokenInfo(chain, tokenData) {
  const tokenInfo = await prismaQuery.mintDataCache.findFirst({
    where: {
      mintAddress: tokenData.address
    }
  });

  if (tokenInfo) return tokenInfo;

  const _chain = CHAINS[chain];
  const connection = new Connection(_chain.rpcUrl, "confirmed");
  const fetchedTokenInfo = await getTokenInfo(tokenData.address, connection);

  // Create fallback data using the mint address
  const shortAddr = tokenData.address.slice(0, 5).toUpperCase();
  const fallbackData = {
    mintAddress: tokenData.address,
    chain: _chain.id,
    name: fetchedTokenInfo?.name || 'Unknown Token',
    symbol: fetchedTokenInfo?.symbol || shortAddr,
    decimals: fetchedTokenInfo?.decimals || 0,
    imageUrl: fetchedTokenInfo?.image || null,
    description: fetchedTokenInfo?.description || `Token at address ${tokenData.address}`,
    uriData: fetchedTokenInfo?.uriData || {},
  };

  // Create and return the token info
  return await prismaQuery.mintDataCache.create({
    data: fallbackData
  });
}