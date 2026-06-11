/**
 * NIP-44 v2 encryption — the payload format NIP-17/NIP-59 gift wrapping is
 * built on (seal and wrap `content`).
 *
 * Implemented on the exact primitive stack the PoC's `nostr-tools@2.23.3`
 * uses (`@noble/ciphers` chacha20, `@noble/hashes` hkdf/hmac/sha256,
 * `@scure/base` base64), so payloads are byte-for-byte interchangeable:
 *
 * - conversation key = HKDF-extract(sha256, ECDH-x(secret, pub), "nip44-v2")
 * - message keys     = HKDF-expand(conversation key, nonce, 76)
 * - ciphertext       = chacha20(key, nonce12, padded plaintext)
 * - mac              = HMAC-sha256(hmac key, nonce || ciphertext)
 * - payload          = base64(0x02 || nonce || ciphertext || mac)
 *
 * Wire compatibility with the PoC is pinned by
 * `__fixtures__/nip17.golden.json` (fixed-nonce encrypt vectors generated
 * from the PoC's own nostr-tools — see `__fixtures__/README.md`).
 *
 * This module is INTERNAL to the chat domain (not re-exported from the
 * package): functions THROW plain `Error`s like the reference
 * implementation; `giftWrap.ts` is the boundary that converts every failure
 * into typed rejection values. The encryption NONCE is a parameter — it is
 * cryptographic entropy and must come from the `Randomness` port (callers'
 * responsibility), never from an ambient RNG.
 */
import { chacha20 } from "@noble/ciphers/chacha.js";
import { bytesToUtf8, equalBytes, utf8ToBytes } from "@noble/ciphers/utils.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { expand as hkdfExpand, extract as hkdfExtract } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { concatBytes, hexToBytes } from "@noble/hashes/utils.js";
import { base64 } from "@scure/base";

const MIN_PLAINTEXT_SIZE = 1;
const MAX_PLAINTEXT_SIZE = 65535;

/**
 * The NIP-44 conversation key between `secretKey` (ours) and `publicKeyHex`
 * (theirs, x-only). Symmetric: `(a.sk, b.pk)` and `(b.sk, a.pk)` derive the
 * same key. Throws if the public key does not lift to a curve point or the
 * secret key is invalid.
 */
export const getConversationKey = (secretKey: Uint8Array, publicKeyHex: string): Uint8Array => {
  const sharedX = secp256k1
    .getSharedSecret(secretKey, hexToBytes(`02${publicKeyHex}`))
    .subarray(1, 33);
  return hkdfExtract(sha256, sharedX, utf8ToBytes("nip44-v2"));
};

interface MessageKeys {
  readonly chachaKey: Uint8Array;
  readonly chachaNonce: Uint8Array;
  readonly hmacKey: Uint8Array;
}

const getMessageKeys = (conversationKey: Uint8Array, nonce: Uint8Array): MessageKeys => {
  const keys = hkdfExpand(sha256, conversationKey, nonce, 76);
  return {
    chachaKey: keys.subarray(0, 32),
    chachaNonce: keys.subarray(32, 44),
    hmacKey: keys.subarray(44, 76),
  };
};

/** Padded length per the NIP-44 power-of-two chunk scheme. */
export const calcPaddedLen = (unpaddedLen: number): number => {
  if (!Number.isSafeInteger(unpaddedLen) || unpaddedLen < 1) {
    throw new Error("expected positive integer");
  }
  if (unpaddedLen <= 32) return 32;
  const nextPower = 1 << (Math.floor(Math.log2(unpaddedLen - 1)) + 1);
  const chunk = nextPower <= 256 ? 32 : nextPower / 8;
  return chunk * (Math.floor((unpaddedLen - 1) / chunk) + 1);
};

const pad = (plaintext: string): Uint8Array => {
  const unpadded = utf8ToBytes(plaintext);
  const length = unpadded.length;
  if (length < MIN_PLAINTEXT_SIZE || length > MAX_PLAINTEXT_SIZE) {
    throw new Error("invalid plaintext size: must be between 1 and 65535 bytes");
  }
  const prefix = Uint8Array.of(length >>> 8, length & 0xff);
  const suffix = new Uint8Array(calcPaddedLen(length) - length);
  return concatBytes(prefix, unpadded, suffix);
};

const unpad = (padded: Uint8Array): string => {
  const high = padded[0];
  const low = padded[1];
  if (high === undefined || low === undefined) throw new Error("invalid padding");
  const unpaddedLen = (high << 8) | low;
  const unpadded = padded.subarray(2, 2 + unpaddedLen);
  if (
    unpaddedLen < MIN_PLAINTEXT_SIZE ||
    unpaddedLen > MAX_PLAINTEXT_SIZE ||
    unpadded.length !== unpaddedLen ||
    padded.length !== 2 + calcPaddedLen(unpaddedLen)
  ) {
    throw new Error("invalid padding");
  }
  return bytesToUtf8(unpadded);
};

const hmacAad = (key: Uint8Array, message: Uint8Array, aad: Uint8Array): Uint8Array => {
  if (aad.length !== 32) throw new Error("AAD associated data must be 32 bytes");
  return hmac(sha256, key, concatBytes(aad, message));
};

interface DecodedPayload {
  readonly nonce: Uint8Array;
  readonly ciphertext: Uint8Array;
  readonly mac: Uint8Array;
}

const decodePayload = (payload: string): DecodedPayload => {
  if (payload.length < 132 || payload.length > 87472) {
    throw new Error(`invalid payload length: ${payload.length}`);
  }
  if (payload.startsWith("#")) throw new Error("unknown encryption version");
  const data = base64.decode(payload);
  if (data.length < 99 || data.length > 65603) {
    throw new Error(`invalid data length: ${data.length}`);
  }
  if (data[0] !== 2) throw new Error(`unknown encryption version ${String(data[0])}`);
  return {
    nonce: data.subarray(1, 33),
    ciphertext: data.subarray(33, -32),
    mac: data.subarray(-32),
  };
};

/**
 * Encrypts `plaintext` under the conversation key with the given 32-byte
 * nonce. The nonce MUST be fresh cryptographic randomness per message
 * (`Randomness` port).
 */
export const encryptNip44 = (
  plaintext: string,
  conversationKey: Uint8Array,
  nonce: Uint8Array,
): string => {
  if (nonce.length !== 32) throw new Error("nonce must be 32 bytes");
  const { chachaKey, chachaNonce, hmacKey } = getMessageKeys(conversationKey, nonce);
  const padded = pad(plaintext);
  const ciphertext = chacha20(chachaKey, chachaNonce, padded);
  const mac = hmacAad(hmacKey, ciphertext, nonce);
  return base64.encode(concatBytes(Uint8Array.of(2), nonce, ciphertext, mac));
};

/** Decrypts a NIP-44 v2 payload. Throws on any malformation or MAC mismatch. */
export const decryptNip44 = (payload: string, conversationKey: Uint8Array): string => {
  const { nonce, ciphertext, mac } = decodePayload(payload);
  const { chachaKey, chachaNonce, hmacKey } = getMessageKeys(conversationKey, nonce);
  if (!equalBytes(hmacAad(hmacKey, ciphertext, nonce), mac)) throw new Error("invalid MAC");
  return unpad(chacha20(chachaKey, chachaNonce, ciphertext));
};

/** `true` when `content` decrypts as a NIP-44 payload under the conversation key. */
export const isDecryptableNip44Payload = (
  content: string,
  conversationKey: Uint8Array,
): boolean => {
  try {
    decryptNip44(content, conversationKey);
    return true;
  } catch {
    return false;
  }
};
