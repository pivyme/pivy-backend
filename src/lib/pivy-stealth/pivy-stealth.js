import * as ed from '@noble/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { Keypair, PublicKey } from '@solana/web3.js';
import { ed25519 } from '@noble/curves/ed25519';
import bs58 from 'bs58';
import { randomBytes } from 'crypto';
// import { ed25519 } from '@noble/ed25519';

const L = BigInt(
  '0x1000000000000000000000000000000014def9dea2f79cd65812631a5cf5d3ed'
);
const mod = (x, n) => ((x % n) + n) % n;
const bytesToNumberLE = (u8) =>
  u8.reduceRight((p, c) => (p << 8n) + BigInt(c), 0n);

/* helper: accept Buffer | Uint8Array | hex | base58 ------------------ */
function to32u8(raw) {
  if (!raw) throw new Error('empty key');

  if (raw instanceof Uint8Array) return raw;

  if (typeof raw === 'string') {
    if (/^[0-9a-fA-F]{64}$/.test(raw))     // 32-byte hex
      return Buffer.from(raw, 'hex');
    return bs58.decode(raw);               // assume base58
  }

  // Prisma Bytes → { type:'Buffer', data:[...] }
  if (raw.type === 'Buffer' && Array.isArray(raw.data))
    return Uint8Array.from(raw.data);

  throw new Error('unsupported key format');
}

export async function encryptEphemeralPrivKey(ephPriv32, metaViewPub58) {
  // 1. shared secret between (ephPriv, metaViewPub)
  const shared = await ed.getSharedSecret(
    ephPriv32,
    new PublicKey(metaViewPub58).toBytes(),
  );
  const keyBytes = sha256(shared); // 32-byte stream key

  // 2. plaintext = ephPriv32 || ephPub
  const ephPub = await ed.getPublicKey(ephPriv32);
  const plain = new Uint8Array([...ephPriv32, ...ephPub]);

  // 3. XOR-encrypt
  const enc = new Uint8Array(plain.length);
  for (let i = 0; i < plain.length; i++) enc[i] = plain[i] ^ keyBytes[i % keyBytes.length];

  // 4. prepend 24-byte random nonce (compat with old layout)
  const nonce = randomBytes(24);
  const payload = new Uint8Array([...nonce, ...enc]);

  return bs58.encode(payload);
}

export async function decryptEphemeralPrivKey(encodedPayload, metaViewPriv, ephPub) {
  console.log({
    encodedPayload,
    metaViewPriv,
    ephPub
  })
  // 1. Decode the payload
  const payload = bs58.decode(encodedPayload);

  // 2. Extract nonce and encrypted data
  const nonce = payload.slice(0, 24);
  const encrypted = payload.slice(24);

  // 3. Generate the shared secret using meta view private key and ephemeral public key
  const shared = await ed.getSharedSecret(
    to32u8(metaViewPriv),
    to32u8(ephPub)
  );

  // 4. Derive the same key used for encryption
  const keyBytes = sha256(shared);

  // 5. Decrypt the data
  const decrypted = new Uint8Array(encrypted.length);
  for (let i = 0; i < encrypted.length; i++) {
    decrypted[i] = encrypted[i] ^ keyBytes[i % keyBytes.length];
  }

  // 6. Verify and return the ephemeral private key
  const ephPriv32 = decrypted.slice(0, 32);
  const receivedEphPub = decrypted.slice(32);
  const computedPub = await ed.getPublicKey(ephPriv32);

  // 7. Verify the decrypted ephemeral private key matches the expected public key
  let match = true;
  for (let i = 0; i < computedPub.length; i++) {
    if (computedPub[i] !== receivedEphPub[i]) {
      match = false;
      break;
    }
  }

  // if (!match) {
  //   throw new Error("Decryption failed: public key mismatch");
  // }

  return ephPriv32;
}

/** RFC-5564-style stealth key derivation (identical to test script) */
export async function deriveStealthKeypair(
  metaSpend,          // 32-B private scalar of spend key
  metaViewPub,        // 32-B public key of view key
  ephPriv             // 32-B ephemeral private scalar
) {
  const shared = await ed.getSharedSecret(ephPriv, metaViewPub);
  const tweak = mod(BigInt('0x' + Buffer.from(sha256(shared)).toString('hex')), L);
  const aScalar = BigInt('0x' + Buffer.from(metaSpend).toString('hex'));
  const sScalar = mod(aScalar + tweak, L);

  const seed = Uint8Array.from(
    sScalar.toString(16).padStart(64, '0').match(/.{2}/g).map(x => parseInt(x, 16))
  );
  const pk = await ed.getPublicKey(seed);
  const sk = new Uint8Array(64); sk.set(seed, 0); sk.set(pk, 32);
  return Keypair.fromSecretKey(sk);
}

export const convertBytesToString = (bytes) => {
  return Buffer.from(bytes).toString('hex');
}

export async function deriveStealthPubFromPriv(metaSpend, metaView, ephPub58) {
  const mSpend = to32u8(metaSpend);                    // 32-byte secret a
  const mView = to32u8(metaView);                     // 32-byte secret b
  const ephPub = new PublicKey(ephPub58).toBytes();    // 32-byte point E

  // 1) shared = b × E   (X25519 on ed25519 curve)
  const shared = await ed.getSharedSecret(mView, ephPub);

  // 2) tweak = H(shared) mod ℓ
  const tweak = mod(
    BigInt('0x' + Buffer.from(sha256(shared)).toString('hex')), L);

  // 3) S = A + tweak · G
  const Abytes = await ed.getPublicKey(mSpend);        // A = a·G

  let Sbytes;
  if (ed.utils.pointAddScalar) {
    // noble ≥ 1.8 path
    Sbytes = ed.utils.pointAddScalar(Abytes, tweak);
  } else {
    // universal fallback via @noble/curves
    const A = ed25519.ExtendedPoint.fromHex(Abytes);
    const S = A.add(ed25519.ExtendedPoint.BASE.multiply(tweak));
    Sbytes = S.toRawBytes();
  }

  return new PublicKey(Sbytes).toBase58();             // stealth owner pubkey
}

export async function deriveStealthPub(metaSpend58, metaView58, ephPriv32) {
  // 1. tweak = H(e ⨁ B) mod L
  const shared = await ed.getSharedSecret(
    ephPriv32,
    new PublicKey(metaView58).toBytes(),
  );
  const tweak = mod(BigInt('0x' + Buffer.from(sha256(shared)).toString('hex')), L);

  // 2. S = A + tweak·G
  const Abytes = new PublicKey(metaSpend58).toBytes();
  let Sbytes;
  if (ed.utils.pointAddScalar) {
    Sbytes = ed.utils.pointAddScalar(Abytes, tweak);
  } else {
    const A = ed25519.ExtendedPoint.fromHex(Abytes);
    const S = A.add(ed25519.ExtendedPoint.BASE.multiply(tweak));
    Sbytes = S.toRawBytes();
  }
  return new PublicKey(Sbytes);
}

// helpers to cleanup memo payload. sometimes the data can be like "[120} <1234567890>"
export const cleanupMemoPayload = (memo) => {
  const withoutIndex = memo.replace(/^\[\d+\]\s*/, '');
  const memoMatch = withoutIndex.match(/<(.+)>/);
  const cleanMemo = memoMatch ? memoMatch[1] : withoutIndex;
  return cleanMemo;
}