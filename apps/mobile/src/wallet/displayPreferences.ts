/**
 * Wallet display preferences — Effect workflows over the KeyValueStorage
 * port (#8), following the localePreference.ts pattern. Pure of any
 * React/Expo import, unit-tested with the in-memory KeyValueStore layer.
 *
 * All workflows have E = never by design: preferences are best-effort. A
 * failed read falls back to the defaults (sat, amounts visible, warning not
 * dismissed); a failed write only means the choice does not stick across
 * restarts.
 */
import { KeyValueStorage } from "@linky/core";
// Subpath import: the pure unit logic only — keeps this module (and its
// vitest run) free of any react-native import chain.
import type { AmountDisplayUnit } from "@linky/ui/amount";
import { DEFAULT_AMOUNT_DISPLAY_UNIT, parseAmountDisplayUnit } from "@linky/ui/amount";
import { Effect, Option } from "effect";

export const DISPLAY_UNIT_STORAGE_KEY = "linky.wallet.displayUnit";
export const HIDE_AMOUNTS_STORAGE_KEY = "linky.wallet.hideAmounts";
export const WALLET_WARNING_DISMISSED_STORAGE_KEY = "linky.wallet.warningDismissed";

export interface AmountDisplayPrefs {
  readonly unit: AmountDisplayUnit;
  readonly hidden: boolean;
}

export const DEFAULT_AMOUNT_DISPLAY_PREFS: AmountDisplayPrefs = {
  unit: DEFAULT_AMOUNT_DISPLAY_UNIT,
  hidden: false,
};

const readFlag = (
  kv: KeyValueStorage.KeyValueStore,
  key: string,
): Effect.Effect<boolean, never, never> =>
  kv.get(key).pipe(
    Effect.map((value) => Option.getOrNull(value) === "1"),
    Effect.catchAll(() => Effect.succeed(false)),
  );

/** The persisted unit + hidden mode, with defaults for unset/unreadable. */
export const loadAmountDisplayPrefs: Effect.Effect<
  AmountDisplayPrefs,
  never,
  KeyValueStorage.KeyValueStore
> = Effect.gen(function* () {
  const kv = yield* KeyValueStorage.KeyValueStore;
  const rawUnit = yield* kv
    .get(DISPLAY_UNIT_STORAGE_KEY)
    .pipe(Effect.catchAll(() => Effect.succeed(Option.none<string>())));
  const hidden = yield* readFlag(kv, HIDE_AMOUNTS_STORAGE_KEY);
  return {
    unit: parseAmountDisplayUnit(Option.getOrNull(rawUnit)) ?? DEFAULT_AMOUNT_DISPLAY_UNIT,
    hidden,
  };
}).pipe(Effect.catchAll(() => Effect.succeed(DEFAULT_AMOUNT_DISPLAY_PREFS)));

export const persistAmountDisplayUnit = (
  unit: AmountDisplayUnit,
): Effect.Effect<void, never, KeyValueStorage.KeyValueStore> =>
  Effect.gen(function* () {
    const kv = yield* KeyValueStorage.KeyValueStore;
    yield* kv.set(DISPLAY_UNIT_STORAGE_KEY, unit);
  }).pipe(Effect.catchAll(() => Effect.void));

export const persistAmountsHidden = (
  hidden: boolean,
): Effect.Effect<void, never, KeyValueStorage.KeyValueStore> =>
  Effect.gen(function* () {
    const kv = yield* KeyValueStorage.KeyValueStore;
    yield* kv.set(HIDE_AMOUNTS_STORAGE_KEY, hidden ? "1" : "0");
  }).pipe(Effect.catchAll(() => Effect.void));

/** Whether the wallet warning was dismissed (wallet.warning, #36). */
export const loadWalletWarningDismissed: Effect.Effect<
  boolean,
  never,
  KeyValueStorage.KeyValueStore
> = Effect.gen(function* () {
  const kv = yield* KeyValueStorage.KeyValueStore;
  return yield* readFlag(kv, WALLET_WARNING_DISMISSED_STORAGE_KEY);
}).pipe(Effect.catchAll(() => Effect.succeed(false)));

export const persistWalletWarningDismissed = (
  dismissed: boolean,
): Effect.Effect<void, never, KeyValueStorage.KeyValueStore> =>
  Effect.gen(function* () {
    const kv = yield* KeyValueStorage.KeyValueStore;
    yield* kv.set(WALLET_WARNING_DISMISSED_STORAGE_KEY, dismissed ? "1" : "0");
  }).pipe(Effect.catchAll(() => Effect.void));
