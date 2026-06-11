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
