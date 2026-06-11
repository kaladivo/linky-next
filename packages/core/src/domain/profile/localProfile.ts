/**
 * Local profile persistence (`onboarding.setup-profile`) — the user's own
 * name/avatar choices, stored as a non-secret preference through the
 * KeyValueStorage port.
 *
 * This is deliberately the SIMPLEST sensible persistence for #17: a single
 * versioned JSON value. The profile is public-by-design metadata (it gets
 * published to Nostr relays in #24), so KeyValueStorage — not SecureStorage —
 * is the right home. If/when profile state moves into the evolu identity/meta
 * domain, only this module changes; callers keep `saveLocalProfile` /
 * `loadLocalProfile`.
 *
 * Bump the `.v1` suffix only with a migration that reads the old key.
 */
import { Effect, Option } from "effect";
import type { PlatformError } from "@effect/platform/Error";

import { KeyValueStorage } from "../../ports/index.js";
import type { AvatarSelection } from "./generatedAvatar.js";

/** The KeyValueStorage key holding the serialized {@link LocalProfile}. */
export const LOCAL_PROFILE_STORAGE_KEY = "linky.profile.v1";

/** Which picture the user chose during setup. */
export type ProfilePictureKind = "generated" | "custom";

export interface LocalProfile {
  readonly name: string;
  /** Canonical picture URL: DiceBear SVG URL or a data URL (custom photo). */
  readonly pictureUrl: string;
  readonly pictureKind: ProfilePictureKind;
  /** The generated-avatar state, kept so editing can resume; null for custom-only. */
  readonly avatarSelection: AvatarSelection | null;
  /** Default `${npub}@linky.fit` Lightning address (profile.default-linky-address). */
  readonly lightningAddress: string;
}

const isProfilePictureKind = (value: unknown): value is ProfilePictureKind =>
  value === "generated" || value === "custom";

const parseLocalProfile = (raw: string): Option.Option<LocalProfile> => {
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return Option.none();
    const candidate = value as Record<string, unknown>;
    if (
      typeof candidate["name"] !== "string" ||
      typeof candidate["pictureUrl"] !== "string" ||
      !isProfilePictureKind(candidate["pictureKind"]) ||
      typeof candidate["lightningAddress"] !== "string"
    ) {
      return Option.none();
    }
    return Option.some({
      name: candidate["name"],
      pictureUrl: candidate["pictureUrl"],
      pictureKind: candidate["pictureKind"],
      avatarSelection: (candidate["avatarSelection"] ?? null) as AvatarSelection | null,
      lightningAddress: candidate["lightningAddress"],
    });
  } catch {
    return Option.none();
  }
};

/** Persists the profile so the app (and a future editor) can read it back. */
export const saveLocalProfile = (
  profile: LocalProfile,
): Effect.Effect<void, PlatformError, KeyValueStorage.KeyValueStore> =>
  Effect.gen(function* () {
    const kv = yield* KeyValueStorage.KeyValueStore;
    yield* kv.set(LOCAL_PROFILE_STORAGE_KEY, JSON.stringify(profile));
  });

/**
 * The stored profile, or `Option.none()` when never saved. A present but
 * unparsable value is also `none` — the profile is a recoverable preference
 * (it can always be re-derived/edited), never worth blocking the app over.
 */
export const loadLocalProfile: Effect.Effect<
  Option.Option<LocalProfile>,
  PlatformError,
  KeyValueStorage.KeyValueStore
> = Effect.gen(function* () {
  const kv = yield* KeyValueStorage.KeyValueStore;
  const raw = yield* kv.get(LOCAL_PROFILE_STORAGE_KEY);
  return Option.flatMap(raw, parseLocalProfile);
});

/**
 * Removes the stored profile — part of `identity.logout` so a later account
 * on the same device never sees the previous user's name/avatar. Idempotent.
 */
export const clearLocalProfile: Effect.Effect<
  void,
  PlatformError,
  KeyValueStorage.KeyValueStore
> = Effect.gen(function* () {
  const kv = yield* KeyValueStorage.KeyValueStore;
  yield* kv.remove(LOCAL_PROFILE_STORAGE_KEY);
});
