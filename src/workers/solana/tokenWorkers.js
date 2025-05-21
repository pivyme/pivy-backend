import axios from "axios";
import { prismaQuery } from "../../lib/prisma.js";
import cron from "node-cron";
import { dexscreenerGetTokenPrice } from "../../utils/solanaUtils.js";
import { sleep } from "../../utils/miscUtils.js";
import { CHAINS } from "../../config.js";


/**
 *
 * @param {import("fastify").FastifyInstance} app
 * @param {*} _
 * @param {Function} done
 */
export const tokenWorker = (app, _, done) => {
  const updateTokenPrices = async () => {
    const tokens = await prismaQuery.mintDataCache.findMany({
      where: {
        chain: {
          in: [CHAINS.MAINNET.id, CHAINS.DEVNET.id]
        }
      },
      orderBy: {
        updatedAt: 'desc'
      }
    });

    for (const token of tokens) {
      try {
        const stableCoins = ["USDC", "USDT", "DAI", "USDC.e", "USDT.e", "DAI.e"];

        if (stableCoins.includes(token.symbol)) {
          await prismaQuery.mintDataCache.update({
            where: { id: token.id },
            data: { priceUsd: 1 }
          });

          continue;
        }

        if (token.chain === 'MAINNET') {
          // Get token price from dexscreener here
          const priceUsd = await dexscreenerGetTokenPrice(token.mintAddress);
          console.log('priceUsd for', token.symbol, ':', priceUsd);

          await prismaQuery.mintDataCache.update({
            where: { id: token.id },
            data: { priceUsd: priceUsd }
          });
        } else {
          // For non-MAINNET chains
          if (token.mintAddress === 'So11111111111111111111111111111111111111112') {
            // Get SOL price from Jupiter API for all chains
            const solPriceRes = await axios.get('https://api.jup.ag/price/v2?ids=So11111111111111111111111111111111111111112');
            const solPriceUsd = parseFloat(solPriceRes.data.data.So11111111111111111111111111111111111111112.price);

            await prismaQuery.mintDataCache.update({
              where: { id: token.id },
              data: { priceUsd: solPriceUsd }
            });
          } else {
            // Set other tokens to 0 on non-MAINNET chains
            await prismaQuery.mintDataCache.update({
              where: { id: token.id },
              data: { priceUsd: 0 }
            });
          }
        }
      } catch (error) {
        console.log('error updating token price for', token.symbol, ':', error);
      } finally {
        await sleep(1000);
      }
    }
  }


  const updateMainPrice = async () => {
    try {
      // SOL price
      const solPriceRes = await axios.get('https://api.jup.ag/price/v2?ids=So11111111111111111111111111111111111111112')
      const solPriceUsd = parseFloat(solPriceRes.data.data.So11111111111111111111111111111111111111112.price)

      await prismaQuery.mainPrice.upsert({
        where: {
          symbol: 'SOL'
        },
        create: {
          symbol: 'SOL',
          priceUsd: solPriceUsd
        },
        update: {
          priceUsd: solPriceUsd
        }
      })

      console.log('Main price updated');
    } catch (error) {
      console.log('error updating main price', error);
    }
  }

  // Every 30 seconds
  updateTokenPrices();
  cron.schedule('*/30 * * * * *', async () => {
    try {
      await updateTokenPrices();
    } catch (error) {
      console.log('Error updating token prices:', error);
    }
  });

  // Every 45 seconds
  updateMainPrice();
  cron.schedule('*/45 * * * * *', async () => {
    await updateMainPrice();
  })

  done();
}