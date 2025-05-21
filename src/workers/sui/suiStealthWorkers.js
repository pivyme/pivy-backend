import { SuiClient } from "@mysten/sui/client";
import { CHAINS, isTestnet } from "../../config.js";

/**
 *
 * @param {import("fastify").FastifyInstance} app
 * @param {*} _
 * @param {Function} done
 */
export const suiStealthWorkers = (app, _, done) => {
  const handleFetchStealthTransactions = async () => {
    try {
      const chain = isTestnet ? CHAINS.SUI_TESTNET : CHAINS.SUI_MAINNET;
      console.log('Fetching tx from', chain.pivyStealthProgramId)

      const client = new SuiClient({
        url: chain.rpcUrl
      })

      const txs = await client.queryTransactionBlocks({
        filter: {
          ChangedObject: chain.pivyStealthProgramId
        }
      })

      console.log('txs: ', txs)

    } catch (error) {
      console.log('error in handleFetchStealthTransactions', error);
    }
  }

  handleFetchStealthTransactions();

  done()
}