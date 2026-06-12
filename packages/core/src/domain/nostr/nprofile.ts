/**
 * NIP-19 `nprofile` TLV codec (issue #45, `chat-pay.request`).
 *
 * A NUT-18 payment request's nostr transport targets an `nprofile` — the
 * REQUESTER's pubkey plus relay hints — so the payer knows where to send
 * the NIP-17 token message. Byte-compatible with nostr-tools'
 * `nip19.nprofileEncode` / `nip19.decode` (the PoC's codec, golden-pinned
 * in `../chat/__fixtures__/paymentRequests.golden.json`): bech32 (not
 * bech32m) with the generous nostr-tools length limit over a TLV payload of
 * type 0 = 32-byte pubkey (exactly once) and type 1 = one UTF-8 relay URL
 * per entry. nostr-tools' `encodeTLV` iterates `Object.entries().reverse()`,
 * so on the wire the RELAY entries come first, then the pubkey — byte
 * compatibility requires the same order (decoding is order-agnostic).
 *
 * Implemented over `@scure/base` like ../identity/nip19.ts — core's
 * dependency set stays noble/scure-only (RN friendly).
 */
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { bech32, utf8 } from "@scure/base";

/** nostr-tools nip19 `Bech32MaxSize`. */
const BECH32_LIMIT = 5000;

const TLV_PUBKEY = 0;
const TLV_RELAY = 1;

export interface NostrProfilePointer {
  /** 64-char lowercase hex pubkey. */
  readonly pubkeyHex: string;
  /** Relay hints, in TLV order (possibly empty). */
  readonly relays: ReadonlyArray<string>;
}

/**
 * Encodes a profile pointer as `nprofile1...`. Returns `null` for a
 * malformed pubkey or a relay that does not fit a one-byte TLV length
 * (nostr-tools would produce an invalid TLV there; we refuse instead).
 */
export const encodeNprofile = (pointer: NostrProfilePointer): string | null => {
  const pubkeyHex = pointer.pubkeyHex.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(pubkeyHex)) return null;

  const entries: Array<Uint8Array> = [];
  const push = (type: number, value: Uint8Array): boolean => {
    if (value.length > 255) return false;
    const entry = new Uint8Array(2 + value.length);
    entry[0] = type;
    entry[1] = value.length;
    entry.set(value, 2);
    entries.push(entry);
    return true;
  };

  // Relay entries FIRST, pubkey last (nostr-tools `encodeTLV` order).
  for (const relay of pointer.relays) {
    const trimmed = relay.trim();
    if (trimmed === "") continue;
    if (!push(TLV_RELAY, utf8.decode(trimmed))) return null;
  }
  if (!push(TLV_PUBKEY, hexToBytes(pubkeyHex))) return null;

  const total = entries.reduce((sum, entry) => sum + entry.length, 0);
  const payload = new Uint8Array(total);
  let offset = 0;
  for (const entry of entries) {
    payload.set(entry, offset);
    offset += entry.length;
  }
  return bech32.encode("nprofile", bech32.toWords(payload), BECH32_LIMIT);
};

/**
 * Decodes an `nprofile1...` string; `null` on anything malformed (wrong
 * prefix, bad checksum, truncated TLV, missing/short pubkey entry) — the
 * same accepted surface as nostr-tools' `nip19.decode` + type check, which
 * is how the PoC validates a request's transport target.
 */
export const decodeNprofile = (encoded: string): NostrProfilePointer | null => {
  let payload: Uint8Array;
  try {
    const decoded = bech32.decode(encoded.trim() as `${string}1${string}`, BECH32_LIMIT);
    if (decoded.prefix !== "nprofile") return null;
    payload = bech32.fromWords(decoded.words);
  } catch {
    return null;
  }

  let pubkeyHex: string | null = null;
  const relays: Array<string> = [];
  let offset = 0;
  while (offset < payload.length) {
    const type = payload[offset];
    const length = payload[offset + 1];
    if (type === undefined || length === undefined) return null;
    const value = payload.subarray(offset + 2, offset + 2 + length);
    if (value.length < length) return null;
    offset += 2 + length;

    if (type === TLV_PUBKEY) {
      if (value.length !== 32) return null;
      // nostr-tools takes the FIRST type-0 entry; extras are ignored.
      pubkeyHex ??= bytesToHex(value);
    } else if (type === TLV_RELAY) {
      try {
        relays.push(utf8.encode(value));
      } catch {
        return null;
      }
    }
    // Unknown TLV types are skipped (forward compatibility, NIP-19).
  }

  if (pubkeyHex === null) return null;
  return { pubkeyHex, relays };
};
