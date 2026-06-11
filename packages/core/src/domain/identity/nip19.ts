/**
 * Internal NIP-19 bech32 encoding for Nostr keys.
 *
 * Byte-compatible with nostr-tools' `nip19.nsecEncode` / `npubEncode` (the
 * PoC's encoder): plain bech32 (not bech32m) with the same generous length
 * limit. Implemented over `@scure/base` — the same library nostr-tools uses
 * internally — to keep core's dependency set noble/scure-only (RN friendly).
 *
 * Internal module — not exported from the package root.
 */
import { bech32 } from "@scure/base";

/** nostr-tools nip19 `Bech32MaxSize`. */
const BECH32_LIMIT = 5000;

/** Encodes 32 key bytes as a NIP-19 bech32 string (`npub1...` / `nsec1...`). */
export const encodeNip19Key = (prefix: "npub" | "nsec", bytes: Uint8Array): string =>
  bech32.encode(prefix, bech32.toWords(bytes), BECH32_LIMIT);

/**
 * Decodes a NIP-19 bech32 key string, accepting only `prefix` and exactly
 * 32 bytes of payload. Returns `null` on any failure (wrong prefix, bad
 * checksum, wrong payload length) — same accepted surface as nostr-tools'
 * `nip19.decode` followed by a type check, which is what the PoC validates
 * pasted keys with. Raw hex input is deliberately NOT accepted (PoC parity).
 */
export const decodeNip19Key = (prefix: "npub" | "nsec", encoded: string): Uint8Array | null => {
  try {
    const decoded = bech32.decode(encoded as `${string}1${string}`, BECH32_LIMIT);
    if (decoded.prefix !== prefix) return null;
    const bytes = bech32.fromWords(decoded.words);
    if (bytes.length !== 32) return null;
    return Uint8Array.from(bytes);
  } catch {
    return null;
  }
};
