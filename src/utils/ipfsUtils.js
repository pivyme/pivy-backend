import { ThirdwebStorage } from "@thirdweb-dev/storage";

const storage = new ThirdwebStorage({
  clientId: process.env.THIRDWEB_CLIENT_ID,
  secretKey: process.env.THIRDWEB_SECRET_KEY
});

export function extractCID(uri) {
  if (!uri) return null;

  // Check if the URI contains "ipfs://" scheme
  if (uri.startsWith("ipfs://")) {
    return uri.split("ipfs://")[1];
  }

  // Check if the URI is an HTTP(S) link and contains /ipfs/<cid>
  const ipfsPath = uri.match(/\/ipfs\/([a-zA-Z0-9]+)/);
  if (ipfsPath && ipfsPath[1]) {
    return ipfsPath[1];
  }

  // CID not found
  return null;
}

export const getIPFSData = async (link) => {
  const cid = extractCID(link);
  console.log('Getting data for CID:', cid);
  const data = await storage.download(`ipfs://${cid}`)
  
  return {
    uri: `ipfs://${cid}`,
    data: await data.json()
  };
}

export const ipfsConvertToThirdwebLink = async (link) => {
  const cid = extractCID(link);
  const _link = storage.resolveScheme(`ipfs://${cid}`)
  console.log('Thirdweb Link:', _link);
}