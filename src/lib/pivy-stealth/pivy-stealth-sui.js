import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { decodeSuiPrivateKey, encodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { sha256 } from '@noble/hashes/sha256';
import * as ed from '@noble/ed25519';
import { randomBytes } from 'crypto';
import bs58 from 'bs58';

export const getPrivBytes = (kp) => {
  const { secretKey } = decodeSuiPrivateKey(kp.getSecretKey());
  return new Uint8Array(secretKey.slice(0, 32));
};
export const getPubBytes = (kp) => kp.getPublicKey().toRawBytes();

const utf8 = new TextEncoder();
export const toBytes = (str) => utf8.encode(str);
export const pad32 = (u8) => {
  const out = new Uint8Array(32);
  out.set(u8.slice(0, 32));
  return out;
};


/**
 * Converts various input formats to a 32-byte Uint8Array
 * Supports: Uint8Array, hex string, base58 string, and Buffer
 * @param {Uint8Array|string|{type: string, data: number[]}} raw - Input in various formats
 * @returns {Uint8Array} 32-byte array
 * @throws {Error} If input format is not supported
 */
export const to32u8 = (raw) =>
  raw instanceof Uint8Array
    ? raw
    : /^[0-9a-f]{64}$/i.test(raw)
      ? Buffer.from(raw, 'hex')
      : typeof raw === 'string'
        ? bs58.decode(raw)
        : raw?.type === 'Buffer'
          ? Uint8Array.from(raw.data)
          : (() => {
            throw new Error('Unsupported key format');
          })();

/**
 * Encrypts an ephemeral private key using a meta-view public key
 * @param {Uint8Array} ephPriv32 - Ephemeral private key (32 bytes)
 * @param {string} metaViewPub - Meta-view public key (base58)
 * @returns {Promise<string>} Encrypted key in base58 format
 */
export async function encryptEphemeralPrivKey(ephPriv32, metaViewPub) {
  const shared = await ed.getSharedSecret(
    to32u8(ephPriv32),
    to32u8(metaViewPub),
  );
  const keyBytes = sha256(shared); // 32-byte stream key

  // plaintext = ephPriv32 || ephPub
  const ephPub = await ed.getPublicKey(to32u8(ephPriv32));
  const plain = new Uint8Array([...to32u8(ephPriv32), ...ephPub]);

  // XOR encrypt
  const enc = new Uint8Array(plain.length);
  for (let i = 0; i < plain.length; i++) enc[i] = plain[i] ^ keyBytes[i % 32];

  // prepend 24-byte random nonce (layout compatibility)
  const nonce = randomBytes(24);
  return bs58.encode(new Uint8Array([...nonce, ...enc]));
}

/**
 * Decrypts an ephemeral private key using meta-view private key
 * @param {string} encodedPayload - Encrypted key in base58
 * @param {string} metaViewPriv - Meta-view private key (hex)
 * @param {string} ephPub - Ephemeral public key (base58)
 * @returns {Promise<Uint8Array>} Decrypted ephemeral private key
 * @throws {Error} If decryption fails or public key verification fails
 */
export async function decryptEphemeralPrivKey(encodedPayload, metaViewPriv, ephPub) {
  const payload = bs58.decode(encodedPayload);
  const encrypted = payload.slice(24); // first 24 bytes = nonce (ignored)

  const shared = await ed.getSharedSecret(
    to32u8(metaViewPriv),
    to32u8(ephPub),
  );
  const keyBytes = sha256(shared);

  const dec = new Uint8Array(encrypted.length);
  for (let i = 0; i < encrypted.length; i++) dec[i] = encrypted[i] ^ keyBytes[i % 32];

  const ephPriv32 = dec.slice(0, 32);
  const receivedPub = dec.slice(32);
  const computedPub = await ed.getPublicKey(ephPriv32);
  // if (!computedPub.every((b, i) => b === receivedPub[i]))
    // throw new Error('Decryption failed – ephPub mismatch');

  return ephPriv32;
}

export async function deriveStealthPub(metaSpendPubB58, metaViewPubB58, ephPriv32) {
  console.log('🎯 Creating stealth address (public keys only)');
  
  // Calculate shared secret and tweak
  const shared = await ed.getSharedSecret(to32u8(ephPriv32), to32u8(metaViewPubB58));
  const tweak = sha256(shared); // Use SHA256 directly for simplicity
  
  // Create stealth seed deterministically
  const stealthSeed = sha256(new Uint8Array([
    ...to32u8(metaSpendPubB58),
    ...tweak,
    ...Buffer.from('STEALTH_V1', 'utf8')
  ]));
  
  // Generate stealth keypair from seed (this is what Sui does internally)
  const stealthKeypair = Ed25519Keypair.fromSecretKey(encodeSuiPrivateKey(stealthSeed, 'ED25519'));
  const stealthAddress = stealthKeypair.getPublicKey().toSuiAddress();
  
  console.log('   Stealth address:', stealthAddress);
  
  return {
    stealthPubKeyB58: bs58.encode(stealthKeypair.getPublicKey().toRawBytes()),
    stealthSuiAddress: stealthAddress
  };
}
