/**
 * `settings.pay-with-cashu` (issue #46) — the toggle gating CASHU contact
 * payments (`chat-pay.contact-method`), following the autoswapSetting.ts
 * pattern (KeyValueStorage port, E = never best-effort). The settings-screen
 * UI lands with #56; #46 ships the setting, its default and the consumer
 * (the chat pay sheet's method choice).
 *
 * PoC parity (`linky.pay_with_cashu` in localStorage,
 * `getInitialPayWithCashuEnabled`): default is ENABLED; an empty/unreadable
 * value reads as enabled; only the literal "1" enables an explicitly stored
 * value (the PoC stored "1"/"0").
 *
 * Scope note: the toggle gates PAYING contacts with Cashu only. Payment
 * REQUESTS stay available (PoC ContactPayPage: the request flow never
 * consults the toggle), and receiving tokens is unaffected.
 */
import { KeyValueStorage } from "@linky/core";
import { Effect, Option } from "effect";

export const PAY_WITH_CASHU_STORAGE_KEY = "linky.settings.payWithCashu";

/** The persisted toggle; unset/unreadable reads as ENABLED (PoC default). */
export const loadPayWithCashuEnabled: Effect.Effect<
  boolean,
  never,
  KeyValueStorage.KeyValueStore
> = Effect.gen(function* () {
  const kv = yield* KeyValueStorage.KeyValueStore;
  const raw = yield* kv
    .get(PAY_WITH_CASHU_STORAGE_KEY)
    .pipe(Effect.catchAll(() => Effect.succeed(Option.none<string>())));
  const value = Option.getOrElse(raw, () => "").trim();
  if (value === "") return true;
  return value === "1";
}).pipe(Effect.catchAll(() => Effect.succeed(true)));

export const persistPayWithCashuEnabled = (
  enabled: boolean,
): Effect.Effect<void, never, KeyValueStorage.KeyValueStore> =>
  Effect.gen(function* () {
    const kv = yield* KeyValueStorage.KeyValueStore;
    yield* kv.set(PAY_WITH_CASHU_STORAGE_KEY, enabled ? "1" : "0");
  }).pipe(Effect.catchAll(() => Effect.void));
