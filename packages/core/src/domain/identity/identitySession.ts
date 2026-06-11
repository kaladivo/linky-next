/**
 * identitySession — persisting the master identity across app launches and
 * clearing it on logout (`identity.persist-secrets` / `identity.logout` in
 * the feature map, issue #14).
 *
 * Stored representation: ONLY the canonical 20-word backup phrase string.
 * The phrase is the canonical recovery material; the master secret and every
 * derived identity are recomputed deterministically from it on load (cheap,
 * and there is no cached copy that could ever diverge from the phrase).
 *
 * SecureStorage keys owned by this module:
 *
 * | Key                                | Value                                  |
 * | ---------------------------------- | -------------------------------------- |
 * | `linky.identity.backupPhrase.v1`   | canonical 20-word SLIP-39 phrase       |
 *
 * Bump the `.v1` suffix only with a migration that reads the old key.
 *
 * Everything handled here is secret material: workflows never log it, and
 * the typed errors deliberately carry no fragment of the stored value —
 * `IdentitySessionCorruptedError` exposes only the failure `reason` enum
 * (see the no-secret-in-error tests in `identitySession.test.ts`).
 *
 * Logout clears LOCAL secrets only. Nothing is deleted remotely: synced data
 * and funds stay recoverable from the backup phrase.
 */
import { Data, Effect, Option } from "effect";

import type { RandomnessError } from "../../ports/Randomness.js";
import type { Randomness } from "../../ports/Randomness.js";
import type { SecureStorageError } from "../../ports/SecureStorage.js";
import { SecureStorage } from "../../ports/SecureStorage.js";
import { createMasterIdentity } from "./createMasterIdentity.js";
import { deriveCashuWallet } from "./deriveCashuWallet.js";
import { deriveNostrIdentity } from "./deriveNostrIdentity.js";
import type { CashuWallet, NostrIdentity } from "./DerivedIdentities.js";
import type { MasterIdentity } from "./MasterIdentity.js";
import type { InvalidBackupPhraseError } from "./restoreMasterIdentity.js";
import { restoreMasterIdentity } from "./restoreMasterIdentity.js";

/** The SecureStorage key holding the canonical backup phrase. */
export const BACKUP_PHRASE_STORAGE_KEY = "linky.identity.backupPhrase.v1";

/**
 * The active session: the master identity plus the derived identities every
 * feature consumes. Evolu owner lanes are NOT part of the session — they are
 * derived per sync domain on demand (`deriveOwnerLane`) because rotating
 * lanes need a rotation index that lives in synced meta state.
 *
 * Every field except `nostr.publicKeyHex`/`nostr.npub` is secret material.
 */
export interface IdentitySession {
  readonly masterIdentity: MasterIdentity;
  readonly nostr: NostrIdentity;
  readonly cashuWallet: CashuWallet;
}

/**
 * The boot decision (`loadSession`):
 * - `NoIdentity` — nothing stored; the app shows onboarding (#17).
 * - `IdentityLoaded` — the persisted identity plus derived identities; the
 *   app shows its normal UI.
 */
export type SessionState =
  | { readonly _tag: "NoIdentity" }
  | { readonly _tag: "IdentityLoaded"; readonly session: IdentitySession };

/**
 * The persisted value exists but is not a restorable backup phrase —
 * something outside this module rewrote or corrupted the keychain entry.
 * The app cannot recover automatically (clearing silently would destroy the
 * user's chance to rescue a mangled-but-rememberable entry).
 *
 * Deliberately carries ONLY the reason enum: never the stored string, its
 * words, or word counts, since any fragment of a stored value may be secret.
 */
export class IdentitySessionCorruptedError extends Data.TaggedError(
  "IdentitySessionCorruptedError",
)<{
  readonly reason: InvalidBackupPhraseError["reason"];
}> {}

/** Derives the in-memory session from a master identity. Pure derivation. */
export const deriveIdentitySession = (
  masterIdentity: MasterIdentity,
): Effect.Effect<IdentitySession> =>
  Effect.gen(function* () {
    const nostr = yield* deriveNostrIdentity(masterIdentity.masterSecret);
    const cashuWallet = yield* deriveCashuWallet(masterIdentity.masterSecret);
    return { masterIdentity, nostr, cashuWallet };
  });

/**
 * Persists `identity` so `loadSession` finds it on the next boot. Called by
 * the create/restore workflows below; exposed for flows that construct the
 * identity separately (e.g. onboarding screens that confirm a backup first).
 */
export const persistIdentity = (
  identity: MasterIdentity,
): Effect.Effect<void, SecureStorageError, SecureStorage> =>
  Effect.gen(function* () {
    const storage = yield* SecureStorage;
    yield* storage.set(BACKUP_PHRASE_STORAGE_KEY, identity.backupPhrase);
  });

/**
 * `identity.create` + persistence: generates a fresh master identity, saves
 * it, and returns the active session. The returned values are secrets.
 */
export const createIdentitySession: Effect.Effect<
  IdentitySession,
  RandomnessError | SecureStorageError,
  Randomness | SecureStorage
> = Effect.gen(function* () {
  const masterIdentity = yield* createMasterIdentity;
  yield* persistIdentity(masterIdentity);
  return yield* deriveIdentitySession(masterIdentity);
});

/**
 * `identity.restore` + persistence: restores from raw backup-word input,
 * saves the canonical phrase, and returns the active session.
 */
export const restoreIdentitySession = (
  input: string,
): Effect.Effect<IdentitySession, InvalidBackupPhraseError | SecureStorageError, SecureStorage> =>
  Effect.gen(function* () {
    const masterIdentity = yield* restoreMasterIdentity(input);
    yield* persistIdentity(masterIdentity);
    return yield* deriveIdentitySession(masterIdentity);
  });

/**
 * Session boot: decides between onboarding and the normal app.
 *
 * Reads the stored backup phrase; absence is the `NoIdentity` branch (a
 * value, not an error). A present-but-unrestorable value fails with
 * {@link IdentitySessionCorruptedError} so the app can surface a real
 * problem instead of silently dropping the user into onboarding while
 * secrets still sit in the keychain.
 */
export const loadSession: Effect.Effect<
  SessionState,
  SecureStorageError | IdentitySessionCorruptedError,
  SecureStorage
> = Effect.gen(function* () {
  const storage = yield* SecureStorage;
  const stored = yield* storage.get(BACKUP_PHRASE_STORAGE_KEY);
  if (Option.isNone(stored)) return { _tag: "NoIdentity" } as const;

  const masterIdentity = yield* restoreMasterIdentity(stored.value).pipe(
    // Map to a reason-only error: InvalidBackupPhraseError may carry words
    // of the (secret) stored value in `unknownWords`; this one never does.
    Effect.catchTag("InvalidBackupPhraseError", (error) =>
      Effect.fail(new IdentitySessionCorruptedError({ reason: error.reason })),
    ),
  );
  const session = yield* deriveIdentitySession(masterIdentity);
  return { _tag: "IdentityLoaded", session } as const;
});

/**
 * `identity.logout`: clears LOCAL session secrets only — removes the stored
 * backup phrase from this device. Nothing is deleted remotely; synced data
 * and funds remain recoverable by restoring from the backup phrase.
 * Idempotent (logging out twice succeeds).
 */
export const clearIdentitySession: Effect.Effect<void, SecureStorageError, SecureStorage> =
  Effect.gen(function* () {
    const storage = yield* SecureStorage;
    yield* storage.delete(BACKUP_PHRASE_STORAGE_KEY);
  });
