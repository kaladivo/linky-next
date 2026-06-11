/**
 * Internal SLIP-39 codec for the Linky master identity.
 *
 * Linky uses exactly one SLIP-39 configuration: a single 20-word share
 * (1-of-1 member in a 1-of-1 group) over a 16-byte master secret with an
 * empty passphrase — the configuration the PoC produced via slip39-ts
 * (`Slip39.fromArray(entropy, { groupThreshold: 1, groups: [[1, 1, "Linky"]] })`).
 * This module reimplements that subset of SLIP-39
 * (https://github.com/satoshilabs/slips/blob/master/slip-0039.md) in pure
 * TypeScript so that:
 *
 * - entropy comes exclusively from the `Randomness` port (slip39-ts draws
 *   from platform crypto internally, which core must never do), and
 * - no WebCrypto (`crypto.subtle`) is required at runtime — `@noble/hashes`
 *   PBKDF2 is synchronous and pure JS, so it runs identically under Node,
 *   React Native, and test Layers.
 *
 * Compatibility with slip39-ts@0.1.13 (and therefore with every backup
 * phrase existing Linky accounts hold) is pinned by the golden fixtures in
 * `__fixtures__/slip39.golden.json` — same phrase -> same master secret
 * bytes, same entropy + identifier -> same phrase.
 *
 * Restore additionally understands non-extendable shares and non-zero
 * iteration exponents (both encodable per the spec and decoded from the
 * share itself); creation always emits the PoC configuration: extendable,
 * iteration exponent 0.
 *
 * This module is internal to `src/domain/identity` — it is NOT exported
 * from the package root. It is pure and total: functions return result
 * values, they never throw for invalid input.
 */
import { pbkdf2 } from "@noble/hashes/pbkdf2.js";
import { sha256 } from "@noble/hashes/sha2.js";

import { SLIP39_WORDLIST } from "./slip39Wordlist.js";

/** Words 1-2: 15-bit identifier + 1-bit extendable flag + 4-bit iteration exponent. */
const ID_EXP_WORDS = 2;
/** Words 3-4: group index/threshold/count + member index/threshold. */
const GROUP_WORDS = 2;
/** Trailing RS1024 checksum words. */
const CHECKSUM_WORDS = 3;
/** A 16-byte secret occupies ceil(128 / 10) = 13 value words. */
const VALUE_WORDS = 13;

/** Linky backup phrases are always exactly 20 words (16-byte master secret). */
export const SLIP39_PHRASE_WORD_COUNT =
  ID_EXP_WORDS + GROUP_WORDS + VALUE_WORDS + CHECKSUM_WORDS;

/** Linky master secrets are always exactly 16 bytes (128-bit entropy). */
export const SLIP39_MASTER_SECRET_BYTES = 16;

const FEISTEL_ROUNDS = 4;
const BASE_ITERATION_COUNT = 10_000;
const MAX_IDENTIFIER = (1 << 15) - 1;

const WORD_INDEX: ReadonlyMap<string, number> = new Map(
  SLIP39_WORDLIST.map((word, index) => [word, index]),
);

// --- RS1024 checksum (SLIP-39 §"Checksum") -------------------------------

const RS1024_GEN = [
  0xe0e040, 0x1c1c080, 0x3838100, 0x7070200, 0xe0e0009, 0x1c0c2412, 0x38086c24, 0x3090fc48,
  0x21b1f890, 0x3f3f120,
] as const;

const asciiBytes = (value: string): ReadonlyArray<number> =>
  Array.from(value, (char) => char.charCodeAt(0));

const CUSTOMIZATION_EXTENDABLE = asciiBytes("shamir_extendable");
const CUSTOMIZATION_NON_EXTENDABLE = asciiBytes("shamir");

const customizationString = (extendable: boolean): ReadonlyArray<number> =>
  extendable ? CUSTOMIZATION_EXTENDABLE : CUSTOMIZATION_NON_EXTENDABLE;

const rs1024Polymod = (values: ReadonlyArray<number>): number => {
  let checksum = 1;
  for (const value of values) {
    const b = checksum >> 20;
    checksum = ((checksum & 0xfffff) << 10) ^ value;
    for (let i = 0; i < RS1024_GEN.length; i++) {
      checksum ^= ((b >> i) & 1) !== 0 ? RS1024_GEN[i]! : 0;
    }
  }
  return checksum;
};

const rs1024CreateChecksum = (
  data: ReadonlyArray<number>,
  extendable: boolean,
): ReadonlyArray<number> => {
  const polymod =
    rs1024Polymod([...customizationString(extendable), ...data, 0, 0, 0]) ^ 1;
  return [(polymod >> 20) & 1023, (polymod >> 10) & 1023, polymod & 1023];
};

const rs1024VerifyChecksum = (data: ReadonlyArray<number>, extendable: boolean): boolean =>
  rs1024Polymod([...customizationString(extendable), ...data]) === 1;

// --- Feistel encryption (SLIP-39 §"Passphrase encryption") ----------------
//
// Linky never uses a SLIP-39 passphrase: the PoC always encrypted and
// recovered with the empty passphrase, so the round password is just the
// single round-index byte.

const feistelRound = (
  round: number,
  iterationExponent: number,
  salt: Uint8Array,
  half: Uint8Array,
): Uint8Array =>
  pbkdf2(sha256, Uint8Array.of(round), concatBytes(salt, half), {
    c: (BASE_ITERATION_COUNT << iterationExponent) / FEISTEL_ROUNDS,
    dkLen: half.length,
  });

const concatBytes = (a: Uint8Array, b: Uint8Array): Uint8Array => {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
};

const xorBytes = (a: Uint8Array, b: Uint8Array): Uint8Array => {
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i]! ^ b[i]!;
  return out;
};

const feistelSalt = (identifier: number, extendable: boolean): Uint8Array =>
  extendable
    ? new Uint8Array(0)
    : Uint8Array.from([...CUSTOMIZATION_NON_EXTENDABLE, (identifier >> 8) & 0xff, identifier & 0xff]);

const feistel = (
  secret: Uint8Array,
  identifier: number,
  extendable: boolean,
  iterationExponent: number,
  direction: "encrypt" | "decrypt",
): Uint8Array => {
  const salt = feistelSalt(identifier, extendable);
  const half = secret.length / 2;
  let left: Uint8Array = secret.slice(0, half);
  let right: Uint8Array = secret.slice(half);
  const rounds = direction === "encrypt" ? [0, 1, 2, 3] : [3, 2, 1, 0];
  for (const round of rounds) {
    const mixed = xorBytes(left, feistelRound(round, iterationExponent, salt, right));
    left = right;
    right = mixed;
  }
  return concatBytes(right, left);
};

// --- Word/value packing ----------------------------------------------------

const valueToIndices = (value: Uint8Array): ReadonlyArray<number> => {
  let acc = 0n;
  for (const byte of value) acc = (acc << 8n) | BigInt(byte);
  const indices: number[] = [];
  for (let i = VALUE_WORDS - 1; i >= 0; i--) {
    indices.push(Number((acc >> (BigInt(i) * 10n)) & 1023n));
  }
  return indices;
};

/**
 * Returns null when the share value padding is invalid: 13 value words carry
 * 130 bits, so for a 128-bit secret the top 2 bits must be zero.
 */
const indicesToValue = (indices: ReadonlyArray<number>): Uint8Array | null => {
  let acc = 0n;
  for (const index of indices) acc = (acc << 10n) | BigInt(index);
  if (acc >> BigInt(SLIP39_MASTER_SECRET_BYTES * 8) !== 0n) return null;
  const out = new Uint8Array(SLIP39_MASTER_SECRET_BYTES);
  for (let i = SLIP39_MASTER_SECRET_BYTES - 1; i >= 0; i--) {
    out[i] = Number(acc & 0xffn);
    acc >>= 8n;
  }
  return out;
};

// --- Encoding (create) ------------------------------------------------------

/**
 * Encodes a 16-byte master secret as the canonical Linky 20-word share:
 * extendable, iteration exponent 0, group 1-of-1, member 1-of-1, empty
 * passphrase — bit-for-bit what the PoC's `createSlip39Share` produced for
 * the same entropy and identifier.
 *
 * `identifier` must be a 15-bit integer (0..32767); callers mask it.
 */
export const encodeLinkyShare = (masterSecret: Uint8Array, identifier: number): string => {
  const id = identifier & MAX_IDENTIFIER;
  const encrypted = feistel(masterSecret, id, true, 0, "encrypt");
  // identifier(15) | extendable(1) | iterationExponent(4), big-endian in 2 words.
  const idExp = (id << 5) | (1 << 4) | 0;
  // groupIndex(4) | groupThreshold-1(4) | groupCount-1(4) | memberIndex(4) | memberThreshold-1(4),
  // all zero for the Linky 1-of-1 configuration.
  const data = [(idExp >> 10) & 1023, idExp & 1023, 0, 0, ...valueToIndices(encrypted)];
  const words = [...data, ...rs1024CreateChecksum(data, true)].map(
    (index) => SLIP39_WORDLIST[index]!,
  );
  return words.join(" ");
};

// --- Decoding (restore) -----------------------------------------------------

export interface DecodedShare {
  readonly identifier: number;
  readonly extendable: boolean;
  readonly iterationExponent: number;
  readonly groupIndex: number;
  readonly groupThreshold: number;
  readonly groupCount: number;
  readonly memberIndex: number;
  readonly memberThreshold: number;
  /** The encrypted master secret carried by the share (16 bytes). */
  readonly encryptedSecret: Uint8Array;
}

export type ShareDecodeResult =
  | { readonly _tag: "Decoded"; readonly share: DecodedShare }
  | { readonly _tag: "UnknownWords"; readonly unknownWords: ReadonlyArray<string> }
  | { readonly _tag: "InvalidChecksum" }
  | { readonly _tag: "InvalidShareFormat"; readonly detail: string };

/**
 * Decodes exactly 20 lowercase wordlist words. The caller is responsible for
 * normalization and for the word-count check.
 */
export const decodeShareWords = (words: ReadonlyArray<string>): ShareDecodeResult => {
  const unknownWords = words.filter((word) => !WORD_INDEX.has(word));
  if (unknownWords.length > 0) return { _tag: "UnknownWords", unknownWords };

  const data = words.map((word) => WORD_INDEX.get(word)!);
  const idExp = (data[0]! << 10) | data[1]!;
  const identifier = idExp >> 5;
  const extendable = ((idExp >> 4) & 1) === 1;
  const iterationExponent = idExp & 0b1111;

  if (!rs1024VerifyChecksum(data, extendable)) return { _tag: "InvalidChecksum" };

  const groupBits = (data[2]! << 10) | data[3]!;
  const groupIndex = (groupBits >> 16) & 0b1111;
  const groupThreshold = ((groupBits >> 12) & 0b1111) + 1;
  const groupCount = ((groupBits >> 8) & 0b1111) + 1;
  const memberIndex = (groupBits >> 4) & 0b1111;
  const memberThreshold = (groupBits & 0b1111) + 1;

  if (groupCount < groupThreshold) {
    return {
      _tag: "InvalidShareFormat",
      detail: `group threshold (${groupThreshold}) exceeds group count (${groupCount})`,
    };
  }

  const encryptedSecret = indicesToValue(
    data.slice(ID_EXP_WORDS + GROUP_WORDS, words.length - CHECKSUM_WORDS),
  );
  if (encryptedSecret === null) {
    return { _tag: "InvalidShareFormat", detail: "non-zero share value padding" };
  }

  return {
    _tag: "Decoded",
    share: {
      identifier,
      extendable,
      iterationExponent,
      groupIndex,
      groupThreshold,
      groupCount,
      memberIndex,
      memberThreshold,
      encryptedSecret,
    },
  };
};

/**
 * Decrypts a decoded single share back into the 16-byte master secret.
 * Only valid for 1-of-1 shares (`groupThreshold === 1 && memberThreshold === 1`);
 * the caller checks that.
 */
export const recoverMasterSecretBytes = (share: DecodedShare): Uint8Array =>
  feistel(
    share.encryptedSecret,
    share.identifier,
    share.extendable,
    share.iterationExponent,
    "decrypt",
  );

/** Encrypt-side counterpart used by golden tests to pin the Feistel layer. */
export const encryptMasterSecretBytes = (
  masterSecret: Uint8Array,
  identifier: number,
  extendable: boolean,
  iterationExponent: number,
): Uint8Array => feistel(masterSecret, identifier, extendable, iterationExponent, "encrypt");
