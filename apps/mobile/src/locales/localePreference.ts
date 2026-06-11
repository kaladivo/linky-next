/**
 * Locale preference persistence — Effect workflows over the KeyValueStorage
 * port (#8). Pure of any React/Expo import, so it is unit-testable with the
 * in-memory KeyValueStore layer.
 *
 * Both workflows have E = never by design: the locale preference is
 * best-effort. A failed read falls back to device-locale resolution, a
 * failed write only means the choice does not stick across restarts —
 * neither is worth surfacing to the user.
 */
import { KeyValueStorage } from "@linky/core";
import type { SupportedLocale } from "@linky/locales";
import { Effect, Option } from "effect";

export const LOCALE_STORAGE_KEY = "linky.locale";

/**
 * The persisted locale preference, or null when unset/unreadable. The raw
 * string is returned on purpose — validation belongs to `resolveLocale`,
 * which treats unsupported values as "no preference".
 */
export const loadPersistedLocale: Effect.Effect<
  string | null,
  never,
  KeyValueStorage.KeyValueStore
> = Effect.gen(function* () {
  const kv = yield* KeyValueStorage.KeyValueStore;
  const value = yield* kv.get(LOCALE_STORAGE_KEY);
  return Option.getOrNull(value);
}).pipe(Effect.catchAll(() => Effect.succeed(null)));

/** Persists an explicit user choice (onboarding/settings set this, #17). */
export const persistLocale = (
  locale: SupportedLocale,
): Effect.Effect<void, never, KeyValueStorage.KeyValueStore> =>
  Effect.gen(function* () {
    const kv = yield* KeyValueStorage.KeyValueStore;
    yield* kv.set(LOCALE_STORAGE_KEY, locale);
  }).pipe(Effect.catchAll(() => Effect.void));
