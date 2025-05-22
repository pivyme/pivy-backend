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
export const suiTokenWorker = (app, _, done) => {
  const updateTokenPrices = async () => {
    const tokens = await prismaQuery.mintDataCache.findMany({
      where: {
        chain: {
          in: [CHAINS.SUI_MAINNET.id, CHAINS.SUI_TESTNET.id]
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

        if (token.chain === 'SUI_MAINNET') {
          // Get token price from dexscreener here
          // TODO: implement SUI price fetching
        } else {
          // For non-MAINNET chains
          if (token.mintAddress === '0x2::sui::SUI') {
            // Get SOL price from Jupiter API for SUI (Wormhole SUI)
            const suiPriceRes = await axios.get('https://api.jup.ag/price/v2?ids=G1vJEgzepqhnVu35BN4jrkv3wVwkujYWFFCxhbEZ1CZr');
            const suiPriceUsd = parseFloat(suiPriceRes.data.data.G1vJEgzepqhnVu35BN4jrkv3wVwkujYWFFCxhbEZ1CZr.price);

            await prismaQuery.mintDataCache.update({
              where: { id: token.id },
              data: { priceUsd: suiPriceUsd }
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
      const suiPriceRes = await axios.get('https://api.jup.ag/price/v2?ids=G1vJEgzepqhnVu35BN4jrkv3wVwkujYWFFCxhbEZ1CZr')
      const suiPriceUsd = parseFloat(suiPriceRes.data.data.G1vJEgzepqhnVu35BN4jrkv3wVwkujYWFFCxhbEZ1CZr.price)

      await prismaQuery.mainPrice.upsert({
        where: {
          symbol: 'SUI'
        },
        create: {
          symbol: 'SUI',
          priceUsd: suiPriceUsd
        },
        update: {
          priceUsd: suiPriceUsd
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
  // updateTokenPrices();

  // Every 45 seconds
  updateMainPrice();
  cron.schedule('*/45 * * * * *', async () => {
    await updateMainPrice();
  })
  // updateMainPrice();

  done();
}