/**
 * customNostrKey — using a pasted `nsec` instead of the derived Nostr key
 * (`identity.use-custom-nostr-key` in the feature map, issue #20).
 *
 * The derived identity (NIP-06 from the master secret, #13) is the DEFAULT;
 * a custom key is an explicit, reversible override. The active identity is
 * modeled as {@link ActiveNostrIdentity}: `source: "derived"` (no override
 * stored) or `source: "custom"` with the override key and the time it was
 * activated.
 *
 * ## Validation (PoC parity)
 *
 * The PoC (`useProfileAuthDomain.decodeNsecPrivateBytes`) accepts ONLY
 * NIP-19 bech32 `nsec1...` strings — `nip19.decode` + type check; raw hex is
 * rejected. We match that, plus an explicit secp256k1 scalar-validity check
 * (the PoC hits the same check later inside `getPublicKey`). Typed failure:
 * {@link InvalidNsecError}, reason-only — never echoes the pasted input.
 *
 * ## Persistence decision
 *
 * The override is a SECRET, so locally it lives in SecureStorage (keychain),
 * exactly like the master backup phrase:
 *
 * | Key                                 | Value                                  |
 * | ----------------------------------- | -------------------------------------- |
 * | `linky.identity.customNostrKey.v1`  | JSON `{ nsec, activatedAtSec }`        |
 *
 * Bump the `.v1` suffix only with a migration that reads the old key.
 *
 * The PoC keeps a local secret copy too (its `writeStoredSecret` +
 * localStorage source/switch-time flags) AND mirrors the override into the
 * Evolu `nostrIdentity` table on the `identity` owner lane (columns
 * `nsec`/`npub`/`source`/`switchedAtSec`, row id `active-nostr-identity`) so
 * the override syncs across devices. Evolu encrypts per lane, so syncing the
 * secret through the identity lane is acceptable — but the Evolu store is
 * not part of the app runtime yet in this repo. The local SecureStorage copy
 * here is the boot-time source of truth (it must be readable before/without
 * Evolu); the synced mirror is an M2 integration:
 *
 * ### M2 integration point (#21/#22/#25/#29)
 *
 * - When the Evolu store joins the runtime, `activateCustomNostrKey` /
 *   `revertToDerivedNostrKey` additionally upsert the
 *   `nostrIdentity` row (`packages/evolu-store`, `identity` domain) with
 *   `source: "custom" | "derived"` and `activatedAtSec`, matching the PoC.
 * - Chat sync (#22/#29) MUST read the active identity from the session
 *   (`IdentitySession.activeNostr`) and, when `source === "custom"`, ignore
 *   incoming events with `created_at < activatedAtSec` — the PoC does this
 *   in `useChatNostrSyncEffect` / `useInboxNotificationsSync` (skip) and as
 *   a NIP-01 `since` filter for profile metadata. `activatedAtSec` is unix
 *   seconds, recorded here at activation time (Effect `Clock`).
 */
import { schnorr } from "@noble/curves/secp256k1.js";
import { Clock, Data, Effect, Encoding, Option } from "effect";

import type { SecureStorageError } from "../../ports/SecureStorage.js";
import { SecureStorage } from "../../ports/SecureStorage.js";
import type { NostrIdentity } from "./DerivedIdentities.js";
import { NostrPublicKeyHex, NostrSecretKey, Npub, Nsec } from "./DerivedIdentities.js";
import { decodeNip19Key, encodeNip19Key } from "./nip19.js";

/** The SecureStorage key holding the custom-key override (JSON, see module doc). */
export const CUSTOM_NOSTR_KEY_STORAGE_KEY = "linky.identity.customNostrKey.v1";

/** Where the active Nostr identity comes from. Matches the PoC's `source` values. */
export type NostrIdentitySource = "derived" | "custom";

/**
 * The active Nostr identity — the single source of truth for which key signs
 * and decrypts (#21+). `derived` is the default (no override stored);
 * `custom` carries `activatedAtSec` (unix seconds), the contract #22/#29 use
 * to ignore pre-switch events from the prior identity (see module doc).
 */
export type ActiveNostrIdentity =
  | { readonly source: "derived"; readonly identity: NostrIdentity }
  | {
      readonly source: "custom";
      readonly identity: NostrIdentity;
      readonly activatedAtSec: number;
    };

/** The `custom` branch of {@link ActiveNostrIdentity}. */
export type CustomNostrIdentity = Extract<ActiveNostrIdentity, { source: "custom" }>;

/**
 * The pasted value is not a usable Nostr secret key. Reason-only by design:
 * the input may be (or contain fragments of) a real secret, so the error
 * never carries it.
 *
 * - `empty` — nothing but whitespace.
 * - `malformed` — not a well-formed NIP-19 `nsec` (wrong prefix, bad bech32
 *   checksum, wrong payload length, raw hex, ...).
 * - `invalid-scalar` — decodes to 32 bytes that are not a valid secp256k1
 *   secret scalar (zero or >= curve order).
 */
export class InvalidNsecError extends Data.TaggedError("InvalidNsecError")<{
  readonly reason: "empty" | "malformed" | "invalid-scalar";
}> {}

/**
 * The stored override exists but cannot be used — something outside this
 * module rewrote or corrupted the keychain entry. Reason-only (the stored
 * value is secret material); the user can recover by reverting to the
 * derived key or pasting the custom key again.
 */
export class CustomNostrKeyCorruptedError extends Data.TaggedError(
  "CustomNostrKeyCorruptedError",
)<{
  readonly reason: "unparseable" | "invalid-nsec";
}> {}

/**
 * Validates a pasted `nsec` and expands it into a full {@link NostrIdentity}.
 * Accepts NIP-19 bech32 only (PoC parity; uppercase bech32 is valid bech32
 * and accepted, the returned `nsec`/`npub` are canonical lowercase).
 */
export const nostrIdentityFromNsec = (
  input: string,
): Effect.Effect<NostrIdentity, InvalidNsecError> =>
  Effect.suspend(() => {
    const trimmed = input.trim();
    if (trimmed === "") return Effect.fail(new InvalidNsecError({ reason: "empty" }));

    const secretKey = decodeNip19Key("nsec", trimmed);
    if (secretKey === null) return Effect.fail(new InvalidNsecError({ reason: "malformed" }));

    let publicKey: Uint8Array;
    try {
      // Throws for scalars outside [1, n-1] — the curve-validity check.
      publicKey = schnorr.getPublicKey(secretKey);
    } catch {
      return Effect.fail(new InvalidNsecError({ reason: "invalid-scalar" }));
    }

    return Effect.succeed({
      secretKey: NostrSecretKey.make(secretKey),
      publicKeyHex: NostrPublicKeyHex.make(Encoding.encodeHex(publicKey)),
      nsec: Nsec.make(encodeNip19Key("nsec", secretKey)),
      npub: Npub.make(encodeNip19Key("npub", publicKey)),
    });
  });

/** Shape of the JSON stored under {@link CUSTOM_NOSTR_KEY_STORAGE_KEY}. */
interface StoredCustomNostrKey {
  readonly nsec: string;
  readonly activatedAtSec: number;
}

const parseStored = (raw: string): StoredCustomNostrKey | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { nsec, activatedAtSec } = parsed as Record<string, unknown>;
  if (typeof nsec !== "string") return null;
  if (typeof activatedAtSec !== "number" || !Number.isInteger(activatedAtSec)) return null;
  if (activatedAtSec <= 0) return null;
  return { nsec, activatedAtSec };
};

/**
 * Reads the stored override, if any. Absence (no override — derived is
 * active) is `Option.none()`, a value, not an error.
 */
export const loadCustomNostrKey: Effect.Effect<
  Option.Option<CustomNostrIdentity>,
  SecureStorageError | CustomNostrKeyCorruptedError,
  SecureStorage
> = Effect.gen(function* () {
  const storage = yield* SecureStorage;
  const stored = yield* storage.get(CUSTOM_NOSTR_KEY_STORAGE_KEY);
  if (Option.isNone(stored)) return Option.none();

  const parsed = parseStored(stored.value);
  if (parsed === null) {
    return yield* Effect.fail(new CustomNostrKeyCorruptedError({ reason: "unparseable" }));
  }

  const identity = yield* nostrIdentityFromNsec(parsed.nsec).pipe(
    // Reason-only re-map: never attach the (secret) stored value as cause.
    Effect.catchTag("InvalidNsecError", () =>
      Effect.fail(new CustomNostrKeyCorruptedError({ reason: "invalid-nsec" })),
    ),
  );
  return Option.some({
    source: "custom",
    identity,
    activatedAtSec: parsed.activatedAtSec,
  } as const);
});

/**
 * `identity.use-custom-nostr-key`: validates the pasted `nsec`, records the
 * switch time (unix seconds, Effect `Clock`, ceil — PoC parity with
 * `Math.ceil(Date.now() / 1000)`), persists the override, and returns the
 * now-active custom identity. Re-activating overwrites the previous
 * override (and its switch time), like the PoC's upsert.
 */
export const activateCustomNostrKey = (
  input: string,
): Effect.Effect<CustomNostrIdentity, InvalidNsecError | SecureStorageError, SecureStorage> =>
  Effect.gen(function* () {
    const identity = yield* nostrIdentityFromNsec(input);
    const millis = yield* Clock.currentTimeMillis;
    const activatedAtSec = Math.ceil(millis / 1000);
    const storage = yield* SecureStorage;
    const stored: StoredCustomNostrKey = { nsec: identity.nsec, activatedAtSec };
    yield* storage.set(CUSTOM_NOSTR_KEY_STORAGE_KEY, JSON.stringify(stored));
    return { source: "custom", identity, activatedAtSec } as const;
  });

/**
 * Switches back to the derived default by deleting the override. Idempotent
 * (reverting while already derived succeeds). The PoC keeps the synced
 * `nostrIdentity` row and nulls its switch time; locally, absence of the
 * SecureStorage entry IS the "derived" state — the M2 Evolu mirror handles
 * the synced row (see module doc).
 */
export const revertToDerivedNostrKey: Effect.Effect<void, SecureStorageError, SecureStorage> =
  Effect.gen(function* () {
    const storage = yield* SecureStorage;
    yield* storage.delete(CUSTOM_NOSTR_KEY_STORAGE_KEY);
  });

/**
 * Resolves the ACTIVE identity: the stored override when present, otherwise
 * the supplied derived identity. `identitySession` uses this so every
 * consumer reads one source of truth (`IdentitySession.activeNostr`).
 */
export const resolveActiveNostrIdentity = (
  derived: NostrIdentity,
): Effect.Effect<
  ActiveNostrIdentity,
  SecureStorageError | CustomNostrKeyCorruptedError,
  SecureStorage
> =>
  loadCustomNostrKey.pipe(
    Effect.map(
      Option.match({
        onNone: () => ({ source: "derived", identity: derived }) as const,
        onSome: (custom) => custom,
      }),
    ),
  );
