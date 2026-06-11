/**
 * deriveNostrIdentity — the default Nostr identity from the master secret
 * (`identity.derive-nostr` in the feature map).
 *
 * Mechanism (PoC-exact, pinned by golden fixtures): NIP-06 over the master
 * secret used directly as the BIP-32 seed — `HDKey.fromMasterSeed(secret)
 * .derive("m/44'/1237'/0'/0/0")` gives the signing key; the public key is
 * the x-only Schnorr point (secp256k1); nsec/npub are NIP-19 bech32.
 *
 * Derivation is pure and infallible for a valid `MasterSecret`; internal
 * crypto invariant violations become defects, not typed errors.
 */
import { schnorr } from "@noble/curves/secp256k1.js";
import { Effect, Encoding } from "effect";

import { NOSTR_DERIVATION_PATH } from "./derivationPaths.js";
import type { NostrIdentity } from "./DerivedIdentities.js";
import { NostrPublicKeyHex, NostrSecretKey, Npub, Nsec } from "./DerivedIdentities.js";
import { derivePrivateKey, hdRootFromMasterSecret } from "./bip85.js";
import type { MasterSecret } from "./MasterIdentity.js";
import { encodeNip19Key } from "./nip19.js";

/**
 * Derives the default Nostr identity. Same master secret -> same npub as the
 * PoC, forever. `secretKey` and `nsec` are secrets — never log them.
 */
export const deriveNostrIdentity = (masterSecret: MasterSecret): Effect.Effect<NostrIdentity> =>
  Effect.sync(() => {
    const root = hdRootFromMasterSecret(masterSecret);
    const secretKey = derivePrivateKey(root, NOSTR_DERIVATION_PATH);
    const publicKey = schnorr.getPublicKey(secretKey);
    return {
      secretKey: NostrSecretKey.make(secretKey),
      publicKeyHex: NostrPublicKeyHex.make(Encoding.encodeHex(publicKey)),
      nsec: Nsec.make(encodeNip19Key("nsec", secretKey)),
      npub: Npub.make(encodeNip19Key("npub", publicKey)),
    };
  });
