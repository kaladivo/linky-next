/**
 * createMasterIdentity — generates a fresh master identity for onboarding
 * (`identity.create` in the feature map).
 *
 * Entropy comes exclusively from the `Randomness` port (16 bytes of master
 * secret + 2 bytes for the 15-bit SLIP-39 share identifier); core never
 * touches platform crypto. The phrase is encoded exactly like the PoC's
 * `createSlip39Share` (slip39-ts defaults: extendable, iteration exponent 0,
 * 1-of-1 share, empty passphrase), pinned by golden fixtures.
 *
 * Contract: account creation must never produce an identity that cannot be
 * recovered. The workflow re-parses the phrase it just generated and checks
 * that it restores to the same master secret; a mismatch is a bug in this
 * package, so it dies (defect) rather than returning a typed error.
 */
import { Effect } from "effect";

import type { RandomnessError } from "../../ports/Randomness.js";
import { Randomness } from "../../ports/Randomness.js";
import type { MasterIdentity } from "./MasterIdentity.js";
import { BackupPhrase, MASTER_SECRET_BYTE_COUNT, MasterSecret } from "./MasterIdentity.js";
import { decodeShareWords, encodeLinkyShare, recoverMasterSecretBytes } from "./slip39.js";

const expectBytes = (
  bytes: Uint8Array,
  expectedLength: number,
): Effect.Effect<Uint8Array, never> =>
  bytes.length === expectedLength
    ? Effect.succeed(bytes)
    : Effect.die(
        new Error(
          `Randomness implementation returned ${bytes.length} bytes, expected ${expectedLength}`,
        ),
      );

const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((byte, i) => byte === b[i]);

/**
 * Creates a new master identity: a 16-byte master secret and its canonical
 * 20-word SLIP-39 backup phrase.
 *
 * The returned values are secrets — never log them.
 */
export const createMasterIdentity: Effect.Effect<MasterIdentity, RandomnessError, Randomness> =
  Effect.gen(function* () {
    const randomness = yield* Randomness;

    const entropy = yield* randomness
      .nextBytes(MASTER_SECRET_BYTE_COUNT)
      .pipe(Effect.flatMap((bytes) => expectBytes(bytes, MASTER_SECRET_BYTE_COUNT)));
    const identifierBytes = yield* randomness
      .nextBytes(2)
      .pipe(Effect.flatMap((bytes) => expectBytes(bytes, 2)));

    // 15-bit share identifier, same masking as slip39-ts generateIdentifier.
    const identifier = ((identifierBytes[0]! & 0x7f) << 8) | identifierBytes[1]!;
    const phrase = encodeLinkyShare(entropy, identifier);

    // Recoverability invariant: the phrase we hand the user MUST restore to
    // the exact secret the account is built on. Violations are defects.
    const decoded = decodeShareWords(phrase.split(" "));
    if (decoded._tag !== "Decoded" || !bytesEqual(recoverMasterSecretBytes(decoded.share), entropy)) {
      return yield* Effect.die(
        new Error("Generated backup phrase failed the restore round-trip check"),
      );
    }

    return {
      backupPhrase: BackupPhrase.make(phrase),
      masterSecret: MasterSecret.make(entropy),
    };
  });
