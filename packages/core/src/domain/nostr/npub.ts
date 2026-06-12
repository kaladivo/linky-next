/**
 * npub input handling for contact entry (`contacts.add` / `contacts.edit`,
 * issue #27).
 *
 * Two layers, PoC parity:
 *
 * - {@link normalizeNpubIdentifier} — the PoC's `utils/nostrNpub`
 *   normalizer: trims, strips a `nostr:` URI prefix, unwraps the local part
 *   of an `<npub>@npub.cash` Lightning address, and lowercases `npub1...`
 *   strings (bech32 is case-insensitive but canonical form is lowercase).
 *   Purely syntactic — it does NOT verify the checksum.
 * - {@link isValidNpub} / {@link npubToPublicKeyHex} — strict NIP-19
 *   validation on top: bech32 decode with the `npub` prefix and exactly
 *   32 payload bytes (the same accepted surface as nostr-tools'
 *   `nip19.decode`, which is what the PoC validates scanned keys with).
 *
 * `npubToPublicKeyHex` bridges contact records (which store npubs) to the
 * NIP-01 fetch workflows (which take 64-char hex pubkeys, e.g.
 * `fetchProfileMetadata`).
 */
import { bytesToHex } from "@noble/hashes/utils.js";

import { decodeNip19Key } from "../identity/nip19.js";

const NOSTR_URI_PREFIX = "nostr:";
const NPUB_CASH_DOMAIN = "npub.cash";

const normalizeNpubCase = (value: string): string => {
  const trimmed = value.trim();
  if (trimmed === "") return "";
  return /^npub1/i.test(trimmed) ? trimmed.toLowerCase() : trimmed;
};

/**
 * Normalizes user-entered npub-ish input (PoC `normalizeNpubIdentifier`):
 * `nostr:` URIs, `<npub>@npub.cash` addresses, and case variants all map to
 * the canonical lowercase `npub1...`. Returns `null` for empty input and
 * for `@`-forms on any domain other than npub.cash. Non-npub strings pass
 * through trimmed — validate with {@link isValidNpub} afterwards.
 */
export const normalizeNpubIdentifier = (value: unknown): string | null => {
  const raw = String(value ?? "").trim();
  if (raw === "") return null;

  const withoutPrefix =
    raw.slice(0, NOSTR_URI_PREFIX.length).toLowerCase() === NOSTR_URI_PREFIX
      ? raw.slice(NOSTR_URI_PREFIX.length).trim()
      : raw;
  if (withoutPrefix === "") return null;

  const atIndex = withoutPrefix.lastIndexOf("@");
  if (atIndex < 0) return normalizeNpubCase(withoutPrefix);
  if (atIndex === 0) return null;

  const localPart = withoutPrefix.slice(0, atIndex).trim();
  const domainPart = withoutPrefix
    .slice(atIndex + 1)
    .trim()
    .toLowerCase();
  if (domainPart !== NPUB_CASH_DOMAIN) return null;
  if (localPart === "") return null;
  return normalizeNpubCase(localPart);
};

/** True iff `value` is a checksum-valid NIP-19 npub (32-byte payload). */
export const isValidNpub = (value: string): boolean => decodeNip19Key("npub", value) !== null;

/**
 * Decodes an npub to its 64-char lowercase hex pubkey (NIP-01 form), or
 * `null` when the input is not a valid npub.
 */
export const npubToPublicKeyHex = (value: string): string | null => {
  const bytes = decodeNip19Key("npub", value);
  return bytes === null ? null : bytesToHex(bytes);
};
