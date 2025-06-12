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
        specialTheme: request.body.specialTheme?.value || 'default',
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

      // Check if there's an inactive link with the same tag
      const existingInactiveLink = await prismaQuery.link.findFirst({
        where: {
          userId: request.user.id,
          tag: slug,
          isActive: false
        },
        include: {
          file: true,
          mint: true
        }
      });

      // Base link data that's common for all types
      const baseLinkData = {
        userId: request.user.id,
        tag: slug,
        label: data.name,
        type: data.type.toUpperCase(),
        emoji: data.emoji,
        backgroundColor: data.backgroundColor,
        description: data.description,
        specialTheme: data.specialTheme,
        isActive: true, // Make sure it's active
      };

      let link;

      // Handle token info if needed
      if (data.amountType === 'fixed') {
        const token = JSON.parse(request.body.token.value);
        const tokenInfo = await getOrCreateTokenInfo(chain, token);
        baseLinkData.amountType = 'FIXED';
        // Store the human readable amount directly
        baseLinkData.amount = Number(request.body.amount.value);
        baseLinkData.mintId = tokenInfo.id;  // Directly set the mintId
      } else {
        baseLinkData.amountType = 'OPEN';
      }

      // If there's an existing inactive link, reactivate and update it
      if (existingInactiveLink) {
        // Handle file for download type
        if (data.type === 'download' && fileData) {
          // Delete existing file if present
          if (existingInactiveLink.file) {
            await prismaQuery.file.delete({
              where: { id: existingInactiveLink.file.id }
            });
          }

          link = await prismaQuery.link.update({
            where: { id: existingInactiveLink.id },
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
          // Delete file if switching from download to simple type
          if (existingInactiveLink.file) {
            await prismaQuery.file.delete({
              where: { id: existingInactiveLink.file.id }
            });
          }

          link = await prismaQuery.link.update({
            where: { id: existingInactiveLink.id },
            data: baseLinkData,
            include: {
              mint: true
            }
          });
        }
      } else {
        // Create new link if no inactive link exists
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

      const message = existingInactiveLink ? "Link reactivated successfully" : "Link created successfully";
      
      return reply.status(200).send({
        message: message,
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
          isActive: true,
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
          },
          payments: {
            include: {
              mint: true
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

        const isPersonalLink = link.tag === "" && link.label === "personal"

        // Process payments to create merged stats
        const paymentStats = {};
        let totalPaymentsCount = 0;

        link.payments.forEach(payment => {
          totalPaymentsCount++;
          const mintAddress = payment.mint.mintAddress;
          
          if (!paymentStats[mintAddress]) {
            paymentStats[mintAddress] = {
              token: {
                id: payment.mint.id,
                mintAddress: payment.mint.mintAddress,
                name: payment.mint.name,
                symbol: payment.mint.symbol,
                decimals: payment.mint.decimals,
                imageUrl: payment.mint.imageUrl,
                description: payment.mint.description,
                priceUsd: payment.mint.priceUsd
              },
              amount: BigInt(0),
              count: 0
            };
          }
          
          paymentStats[mintAddress].amount += BigInt(payment.amount);
          paymentStats[mintAddress].count++;
        });

        // Convert to array and format amounts
        const mergedPaymentStats = Object.values(paymentStats).map(stat => ({
          token: stat.token,
          amount: stat.amount.toString(),
          // Convert to human readable amount
          humanReadableAmount: Number(stat.amount) / (10 ** stat.token.decimals),
          count: stat.count
        }));

        console.log('link.viewCount', link.viewCount);
        return {
          ...link,
          linkPreview,
          // Amount is already in human readable format
          amount: link.amount,
          isPersonalLink,
          // Add chain amount if fixed amount type
          chainAmount: link.amount && link.mint ? 
            BigInt(link.amount * (10 ** link.mint.decimals)).toString() : 
            null,
          stats: {
            viewCount: link.viewCount,
            totalPayments: totalPaymentsCount,
            paymentStats: mergedPaymentStats
          },
          // Remove payments from the response to keep it clean
          payments: undefined
        };
      });

      // Make the personal link the first item in the array
      const personalLink = linkObjects.find(link => link.isPersonalLink);
      if (personalLink) {
        linkObjects.splice(0, 0, personalLink);
      }

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

  app.post('/update-link/:linkId', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    try {
      const { chain = 'DEVNET' } = request.query;
      const { linkId } = request.params;

      // Extract data from request.body
      const data = {
        type: request.body.type?.value,
        name: request.body.name?.value,
        slug: request.body.slug?.value,
        amountType: request.body.amountType?.value,
        description: request.body.description?.value,
        emoji: request.body.emoji?.value,
        backgroundColor: request.body.backgroundColor?.value,
        specialTheme: request.body.specialTheme?.value || 'default',
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

      // First check if the link exists and belongs to the user
      const existingLink = await prismaQuery.link.findFirst({
        where: { 
          id: linkId,
          isActive: true
        },
        include: { file: true }
      });

      if (!existingLink) {
        return reply.status(404).send({
          message: "Link not found",
          error: "The specified link does not exist",
          data: null
        });
      }

      if (existingLink.userId !== request.user.id) {
        return reply.status(403).send({
          message: "Unauthorized",
          error: "You don't have permission to update this link",
          data: null
        });
      }

      // Base link data for update
      const updateData = {
        label: data.name,
        tag: data.slug,
        emoji: data.emoji,
        backgroundColor: data.backgroundColor,
        description: data.description,
        specialTheme: data.specialTheme,
      };

      // Handle token info if needed
      if (data.amountType === 'fixed') {
        const token = JSON.parse(request.body.token.value);
        const tokenInfo = await getOrCreateTokenInfo(chain, token);
        updateData.amountType = 'FIXED';
        updateData.amount = Number(request.body.amount.value);
        updateData.mintId = tokenInfo.id;
      } else if (data.amountType === 'open') {
        updateData.amountType = 'OPEN';
        updateData.amount = null;
        updateData.mintId = null;
      }

      let updatedLink;

      // Update the link with file if it's a download type
      if (existingLink.type === 'DOWNLOAD' && fileData) {
        // Delete existing file if present
        if (existingLink.file) {
          await prismaQuery.file.delete({
            where: { id: existingLink.file.id }
          });
        }

        updatedLink = await prismaQuery.link.update({
          where: { id: linkId },
          data: {
            ...updateData,
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
        updatedLink = await prismaQuery.link.update({
          where: { id: linkId },
          data: updateData,
          include: {
            mint: true
          }
        });
      }

      // Remove the file buffer from the response
      if (updatedLink.file) {
        updatedLink.file = {
          ...updatedLink.file,
          data: undefined
        };
      }

      // Format the response to include both UI and chain amounts
      const responseLink = {
        ...updatedLink,
        amount: updatedLink.amount,
        chainAmount: updatedLink.amount && updatedLink.mint ? 
          BigInt(updatedLink.amount * (10 ** updatedLink.mint.decimals)).toString() : 
          null
      };

      return reply.status(200).send({
        message: "Link updated successfully",
        data: responseLink
      });
    } catch (error) {
      console.error('Error updating link:', error);

      if (error.code === 'FST_REQ_FILE_TOO_LARGE') {
        return reply.status(413).send({
          message: "File size too large",
          error: "Maximum file size is 5MB",
          data: null
        });
      }

      return reply.status(500).send({
        message: "Error updating link",
        error: error.message,
        data: null
      });
    }
  });

  app.delete('/delete-link/:linkId', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    try {
      const { linkId } = request.params;

      // First check if the link exists and belongs to the user
      const existingLink = await prismaQuery.link.findFirst({
        where: { 
          id: linkId,
          isActive: true
        },
        include: { file: true }
      });

      if (!existingLink) {
        return reply.status(404).send({
          message: "Link not found",
          error: "The specified link does not exist or has been deleted",
          data: null
        });
      }

      // Check if it's a personal link (which cannot be deleted)
      const isPersonalLink = existingLink.tag === "" && existingLink.label === "personal";
      if (isPersonalLink) {
        return reply.status(403).send({
          message: "Cannot delete personal link",
          error: "Personal links cannot be deleted",
          data: null
        });
      }

      if (existingLink.userId !== request.user.id) {
        return reply.status(403).send({
          message: "Unauthorized",
          error: "You don't have permission to delete this link",
          data: null
        });
      }

      // Soft delete the link by setting isActive to false
      await prismaQuery.link.update({
        where: { id: linkId },
        data: { isActive: false }
      });

      return reply.status(200).send({
        message: "Link deleted successfully",
        data: null
      });
    } catch (error) {
      console.error('Error deleting link:', error);
      return reply.status(500).send({
        message: "Error deleting link",
        error: error.message,
        data: null
      });
    }
  });

  done();
}

// Helper function to get or create token info
async function getOrCreateTokenInfo(chain, tokenData) {
  try {
    const chainId = CHAINS[chain].id;
    
    // Check if token exists in cache
    const existingCache = await prismaQuery.mintDataCache.findUnique({
      where: {
        mintAddress_chain: {
          mintAddress: tokenData.address,
          chain: chainId
        }
      }
    });

    if (existingCache && !existingCache.isInvalid) {
      return existingCache;
    }

    // Create fallback data using the mint address
    const shortAddr = tokenData.address.slice(0, 5).toUpperCase();
    const cacheData = {
      mintAddress: tokenData.address,
      chain: chainId,
      name: tokenData.name || `Unknown Token ${shortAddr}`,
      symbol: tokenData.symbol || shortAddr,
      decimals: tokenData.decimals || 0,
      imageUrl: tokenData.image || null,
      description: `Token at address ${tokenData.address}`,
      uriData: {},
      isInvalid: false
    };

    // Create and return the token info
    return await prismaQuery.mintDataCache.create({
      data: cacheData
    });
  } catch (error) {
    console.error('Error in getOrCreateTokenInfo:', error);
    throw error;
  }
}