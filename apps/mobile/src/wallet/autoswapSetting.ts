/**
 * `settings.cashu-autoswap` (issue #42) — the auto-consolidation toggle's
 * underlying setting, following the displayPreferences.ts pattern
 * (KeyValueStorage port, E = never best-effort). The toggle UI itself
 * lands with #56; #42 ships the setting, its default and the consumers
 * (autoswapRunner, the select-main flow).
 *
 * PoC parity (`linky.cashu_autoswap.v1` in localStorage): default is
 * ENABLED; an empty/unreadable value reads as enabled; only the literal
 * "0" disables (we store "0"/"1", the PoC stored "1"/"0" too).
 *
 * Device-local on purpose (like the PoC and the display preferences):
 * autoswap moves funds in the background, so enabling it is a per-device
 * decision — a synced value could surprise-enable fund movement on a
 * device the user never touched.
 */
import { KeyValueStorage } from "@linky/core";
import { Effect, Option } from "effect";

export const CASHU_AUTOSWAP_STORAGE_KEY = "linky.settings.cashuAutoswap";

/** The persisted toggle; unset/unreadable reads as ENABLED (PoC default). */
export const loadCashuAutoswapEnabled: Effect.Effect<
  boolean,
  never,
  KeyValueStorage.KeyValueStore
> = Effect.gen(function* () {
  const kv = yield* KeyValueStorage.KeyValueStore;
  const raw = yield* kv
    .get(CASHU_AUTOSWAP_STORAGE_KEY)
    .pipe(Effect.catchAll(() => Effect.succeed(Option.none<string>())));
  const value = Option.getOrElse(raw, () => "").trim();
  if (value === "") return true;
  return value === "1";
}).pipe(Effect.catchAll(() => Effect.succeed(true)));

export const persistCashuAutoswapEnabled = (
  enabled: boolean,
): Effect.Effect<void, never, KeyValueStorage.KeyValueStore> =>
  Effect.gen(function* () {
    const kv = yield* KeyValueStorage.KeyValueStore;
    yield* kv.set(CASHU_AUTOSWAP_STORAGE_KEY, enabled ? "1" : "0");
  }).pipe(Effect.catchAll(() => Effect.void));
