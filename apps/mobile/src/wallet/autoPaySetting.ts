/**
 * Auto-pay limit setting (`lightning.autopay-limit`, #39) — the persisted
 * half of core's `decideAutoPay` contract, following the
 * displayPreferences.ts pattern (KeyValueStorage port, E = never,
 * best-effort persistence).
 *
 * PoC semantics (`useAppPreferences` + `linky.lightning_invoice_auto_pay_limit`):
 * a single sat limit, default 10 000, no separate on/off switch — the
 * settings UI (#56) offers 0 / 1 000 / 10 000 / 100 000, where 0 means
 * "always confirm". Auto-pay is therefore "on by default" with the 10 000
 * sat bound, and `enabled` is constant `true` in the stored shape (a 0
 * limit never auto-pays any positive amount).
 */
import type { AutoPaySetting } from "@linky/core";
import { KeyValueStorage } from "@linky/core";
import { Effect, Option } from "effect";

export const AUTO_PAY_LIMIT_STORAGE_KEY = "linky.wallet.autopayLimitSat";

/** PoC `LIGHTNING_INVOICE_AUTO_PAY_LIMIT_SAT`. */
export const DEFAULT_AUTO_PAY_LIMIT_SAT = 10_000;

/** PoC `LIGHTNING_INVOICE_AUTO_PAY_LIMIT_OPTIONS` — the #56 settings UI. */
export const AUTO_PAY_LIMIT_OPTIONS_SAT = [0, 1_000, 10_000, 100_000] as const;

/** PoC parse rule: any finite integer ≥ 0 sticks, anything else = default. */
export const parseAutoPayLimitSat = (raw: string | null): number => {
  const parsed = Number.parseInt(String(raw ?? "").trim(), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_AUTO_PAY_LIMIT_SAT;
};

/** The persisted auto-pay setting (default: enabled, 10 000 sat). */
export const loadAutoPaySetting: Effect.Effect<
  AutoPaySetting,
  never,
  KeyValueStorage.KeyValueStore
> = Effect.gen(function* () {
  const kv = yield* KeyValueStorage.KeyValueStore;
  const raw = yield* kv
    .get(AUTO_PAY_LIMIT_STORAGE_KEY)
    .pipe(Effect.catchAll(() => Effect.succeed(Option.none<string>())));
  return { enabled: true, limitSat: parseAutoPayLimitSat(Option.getOrNull(raw)) };
}).pipe(
  Effect.catchAll(() =>
    Effect.succeed({ enabled: true, limitSat: DEFAULT_AUTO_PAY_LIMIT_SAT }),
  ),
);

/** Persists the user's limit choice (#56's UI calls this). */
export const persistAutoPayLimitSat = (
  limitSat: number,
): Effect.Effect<void, never, KeyValueStorage.KeyValueStore> =>
  Effect.gen(function* () {
    const kv = yield* KeyValueStorage.KeyValueStore;
    yield* kv.set(AUTO_PAY_LIMIT_STORAGE_KEY, String(Math.max(0, Math.floor(limitSat))));
  }).pipe(Effect.catchAll(() => Effect.void));
