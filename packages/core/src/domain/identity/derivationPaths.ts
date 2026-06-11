/**
 * BIP-32 derivation paths for every identity derived from the master secret.
 * Internal to `src/domain/identity` — the paths are an implementation detail;
 * the public contract is "same master secret -> same derived values", pinned
 * by `__fixtures__/derivedIdentities.golden.json`.
 *
 * These replicate the PoC (`linky-poc/packages/core/src/identity`) exactly:
 *
 * - Nostr: NIP-06 path `m/44'/1237'/0'/0/0` over the BIP-32 root built
 *   directly from the master secret (`HDKey.fromMasterSeed(masterSecret)` —
 *   the 16 secret bytes ARE the seed; there is no BIP-39 step in between).
 * - Cashu + owner lanes: BIP-85-style entropy (`m/83696968'/39'/...`,
 *   HMAC-SHA512 keyed "bip-entropy-from-k" over the node's private key).
 *
 * Owner-lane branch layout under `m/83696968'/39'/0'/24'/`:
 *
 *   0' .......... Cashu wallet entropy (not a lane)
 *   1'/0' ....... meta (fixed)
 *   2'/<i>' ..... contacts
 *   3'/<i>' ..... wallet (the PoC's "cashu" role)
 *   4'/<i>' ..... messages
 *   5'/<i>' ..... transactions
 *   6'/0' ....... RESERVED — never used (see below)
 *
 * IMPORTANT — the `identity` lane: the PoC defines an `IDENTITY_OWNER_PATH`
 * at `6'/0'`, but its production derivation (`deriveOwnerPath` in
 * `linky-poc/packages/core/src/identity/utils.ts`, called by the web app for
 * every lane) has no `identity` branch and falls through to the messages
 * path. Production data for the identity lane therefore lives at `4'/0'`,
 * identical to messages lane 0. We replicate that EXACTLY — restored
 * accounts must reconnect to the lanes app.linky.fit populated. The `6'`
 * branch stays reserved/unused.
 */
import type { OwnerLaneIndex, SyncDomain } from "./DerivedIdentities.js";

/** NIP-06 Nostr key path (BIP-44 coin type 1237). */
export const NOSTR_DERIVATION_PATH = "m/44'/1237'/0'/0/0";

/** BIP-85 application path for the Cashu wallet entropy (39'=BIP-39, 24 words, index 0). */
export const CASHU_SEED_DERIVATION_PATH = "m/83696968'/39'/0'/24'/0'";

const LANE_PREFIX = "m/83696968'/39'/0'/24'";

/** The derivation path of one owner lane. Callers validate fixed-domain indices. */
export const ownerLaneDerivationPath = (domain: SyncDomain, index: OwnerLaneIndex): string => {
  switch (domain) {
    case "meta":
      return `${LANE_PREFIX}/1'/0'`;
    case "contacts":
      return `${LANE_PREFIX}/2'/${index}'`;
    case "wallet":
      return `${LANE_PREFIX}/3'/${index}'`;
    // PoC fallthrough, kept on purpose: production's identity lane IS
    // messages lane 0 (see module doc).
    case "identity":
      return `${LANE_PREFIX}/4'/0'`;
    case "messages":
      return `${LANE_PREFIX}/4'/${index}'`;
    case "transactions":
      return `${LANE_PREFIX}/5'/${index}'`;
  }
};
