/**
 * chatTestKit — shared utilities for the chat domain tests ONLY.
 *
 * Excluded from the build (`tsconfig.build.json`); never exported from the
 * package. Tests import it directly.
 */
import { Effect, Layer } from "effect";

import { Randomness } from "../../ports/Randomness.js";
import { nostrIdentityFromNsec } from "../identity/customNostrKey.js";
import type { NostrIdentity } from "../identity/DerivedIdentities.js";
import { encodeNip19Key } from "../identity/nip19.js";
import { hexToBytes } from "../nostr/nostrTestKit.js";

/** Same throwaway keys as `__fixtures__/nip17.golden.json`. */
export const ALICE_SECRET_KEY_HEX =
  "7f3b02c9d3a8e15b64f2a90c81d6e4775ab9c0d2e3f415263748596a7b8c9d0e";
export const BOB_SECRET_KEY_HEX =
  "1e0d9c8b7a695847362514f3e2d1c0b95a7d86e4c2b0a1928374655647382910";

/** A full NostrIdentity (branded fields) from a raw 32-byte secret key hex. */
export const identityFromSecretKeyHex = (secretKeyHex: string): NostrIdentity =>
  Effect.runSync(
    nostrIdentityFromNsec(encodeNip19Key("nsec", hexToBytes(secretKeyHex))).pipe(Effect.orDie),
  );

export const alice = identityFromSecretKeyHex(ALICE_SECRET_KEY_HEX);
export const bob = identityFromSecretKeyHex(BOB_SECRET_KEY_HEX);

/**
 * Deterministic but NON-repeating "CSPRNG": every draw differs (counter
 * tagged into each block), so consecutive ephemeral wrap keys and NIP-44
 * nonces are distinct — unlike `RandomnessFixed`, which would make two
 * wraps of the same rumor byte-identical.
 */
export const RandomnessCounter: Layer.Layer<Randomness> = Layer.sync(Randomness, () => {
  let counter = 0;
  return {
    nextBytes: (byteCount) =>
      Effect.sync(() => {
        counter += 1;
        const bytes = new Uint8Array(byteCount);
        for (let i = 0; i < byteCount; i += 1) {
          bytes[i] = (counter * 31 + i * 7 + 13) % 251;
        }
        return bytes;
      }),
  };
});
