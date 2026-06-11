/**
 * Derived identity domain types — everything the app derives from the
 * 16-byte master secret (issue #13, `identity.derive-*` in the feature map):
 *
 * - the default Nostr identity (signing key, x-only public key, nsec/npub),
 * - the deterministic Cashu wallet seed (fund recovery depends on it),
 * - the Evolu owner lanes, one BIP-39 mnemonic per sync domain.
 *
 * All values are deterministic functions of the master secret, byte-for-byte
 * compatible with what the PoC (app.linky.fit) derives today — pinned by the
 * golden fixtures in `__fixtures__/derivedIdentities.golden.json`.
 *
 * Everything here except `NostrPublicKeyHex` / `Npub` is secret material:
 * never log it, never embed it in errors, never store it outside the
 * SecureStorage port.
 */
import { validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { Schema } from "effect";

const hasByteLength =
  (expected: number) =>
  (input: unknown): input is Uint8Array =>
    input instanceof Uint8Array && input.length === expected;

const isLowercaseHex = (expectedLength: number) => (input: unknown): input is string =>
  typeof input === "string" && new RegExp(`^[0-9a-f]{${expectedLength}}$`).test(input);

// 32 bytes of data -> 52 bech32 words + 6 checksum chars after the "1".
const BECH32_KEY_BODY = "[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{58}";

const isBip39Mnemonic =
  (expectedWordCount: number) =>
  (input: unknown): input is string => {
    if (typeof input !== "string") return false;
    if (input.split(" ").length !== expectedWordCount) return false;
    return validateMnemonic(input, wordlist);
  };

/** The derived Nostr signing key — 32 secret bytes (BIP-32 private key). */
export const NostrSecretKey = Schema.Uint8ArrayFromSelf.pipe(
  Schema.filter(hasByteLength(32), { description: "a Uint8Array of exactly 32 bytes" }),
  Schema.brand("NostrSecretKey"),
);
export type NostrSecretKey = typeof NostrSecretKey.Type;

/** The x-only Schnorr public key as 64 lowercase hex chars (NIP-01 pubkey). */
export const NostrPublicKeyHex = Schema.String.pipe(
  Schema.filter(isLowercaseHex(64), { description: "64 lowercase hex characters" }),
  Schema.brand("NostrPublicKeyHex"),
);
export type NostrPublicKeyHex = typeof NostrPublicKeyHex.Type;

/** The NIP-19 bech32 encoding of the secret key. Secret. */
export const Nsec = Schema.String.pipe(
  Schema.filter((input): input is string => new RegExp(`^nsec1${BECH32_KEY_BODY}$`).test(input), {
    description: "a NIP-19 nsec string",
  }),
  Schema.brand("Nsec"),
);
export type Nsec = typeof Nsec.Type;

/** The NIP-19 bech32 encoding of the public key. Shareable. */
export const Npub = Schema.String.pipe(
  Schema.filter((input): input is string => new RegExp(`^npub1${BECH32_KEY_BODY}$`).test(input), {
    description: "a NIP-19 npub string",
  }),
  Schema.brand("Npub"),
);
export type Npub = typeof Npub.Type;

/**
 * The default Nostr identity derived from the master secret
 * (`identity.derive-nostr`). A custom pasted nsec
 * (`identity.use-custom-nostr-key`) overrides it explicitly — it never
 * replaces this derivation.
 */
export interface NostrIdentity {
  readonly secretKey: NostrSecretKey;
  readonly publicKeyHex: NostrPublicKeyHex;
  readonly nsec: Nsec;
  readonly npub: Npub;
}

/**
 * The 24-word BIP-39 mnemonic encoding the Cashu wallet entropy (BIP-85
 * application). Shown/exported so funds are recoverable in other Cashu
 * wallets. Secret.
 */
export const CashuMnemonic = Schema.String.pipe(
  Schema.filter(isBip39Mnemonic(24), { description: "a 24-word BIP-39 mnemonic" }),
  Schema.brand("CashuMnemonic"),
);
export type CashuMnemonic = typeof CashuMnemonic.Type;

/** The 64-byte BIP-39 seed of `CashuMnemonic` — what cashu-ts consumes. Secret. */
export const CashuSeed = Schema.Uint8ArrayFromSelf.pipe(
  Schema.filter(hasByteLength(64), { description: "a Uint8Array of exactly 64 bytes" }),
  Schema.brand("CashuSeed"),
);
export type CashuSeed = typeof CashuSeed.Type;

/** The deterministic Cashu wallet identity (`identity.derive-cashu-seed`). */
export interface CashuWallet {
  readonly mnemonic: CashuMnemonic;
  readonly seed: CashuSeed;
}

/**
 * The sync domains — each one is a separate Evolu owner lane so its data
 * syncs (and can be rotated/deleted) independently
 * (`identity.derive-sync-identities`).
 *
 * `meta` and `identity` are fixed single lanes; the other four rotate via a
 * lane index. `wallet` is the PoC's `cashu` role (same derivation path).
 */
export const SyncDomain = Schema.Literal(
  "meta",
  "identity",
  "contacts",
  "wallet",
  "messages",
  "transactions",
);
export type SyncDomain = typeof SyncDomain.Type;

/** Sync domains whose lane can rotate to a higher index. */
export const ROTATING_SYNC_DOMAINS = ["contacts", "wallet", "messages", "transactions"] as const;

/** Lane rotation index. Fixed domains (`meta`, `identity`) only allow 0. */
export const OwnerLaneIndex = Schema.Number.pipe(
  Schema.int(),
  Schema.nonNegative(),
  Schema.brand("OwnerLaneIndex"),
);
export type OwnerLaneIndex = typeof OwnerLaneIndex.Type;

/**
 * The 12-word BIP-39 mnemonic that seeds one Evolu owner lane. This mnemonic
 * is the lane contract between core and `packages/evolu-store`: evolu-store
 * turns it into an Evolu `AppOwner` (SLIP-21, `@evolu/common`), which core
 * must never import. Secret.
 */
export const OwnerLaneMnemonic = Schema.String.pipe(
  Schema.filter(isBip39Mnemonic(12), { description: "a 12-word BIP-39 mnemonic" }),
  Schema.brand("OwnerLaneMnemonic"),
);
export type OwnerLaneMnemonic = typeof OwnerLaneMnemonic.Type;

/** One derived Evolu owner lane: a sync domain at a rotation index. */
export interface OwnerLane {
  readonly domain: SyncDomain;
  readonly index: OwnerLaneIndex;
  readonly mnemonic: OwnerLaneMnemonic;
}
