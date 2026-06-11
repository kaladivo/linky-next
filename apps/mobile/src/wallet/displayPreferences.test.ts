/**
 * Display-preference workflows against the in-memory KeyValueStore layer —
 * exactly how the production code runs them, minus AsyncStorage.
 */
import { KeyValueStorage } from "@linky/core";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_AMOUNT_DISPLAY_PREFS,
  DISPLAY_UNIT_STORAGE_KEY,
  loadAmountDisplayPrefs,
  loadWalletWarningDismissed,
  persistAmountDisplayUnit,
  persistAmountsHidden,
  persistWalletWarningDismissed,
} from "./displayPreferences";

const run = <A>(effect: Effect.Effect<A, never, KeyValueStorage.KeyValueStore>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(KeyValueStorage.layerMemory)));

describe("amount display prefs", () => {
  it("defaults to sat + visible when nothing is persisted", async () => {
    await expect(run(loadAmountDisplayPrefs)).resolves.toEqual(DEFAULT_AMOUNT_DISPLAY_PREFS);
  });

  it("round-trips the display unit", async () => {
    const result = await run(
      persistAmountDisplayUnit("btc").pipe(Effect.andThen(loadAmountDisplayPrefs)),
    );
    expect(result.unit).toBe("btc");
  });

  it("round-trips hidden mode independently of the unit", async () => {
    const result = await run(
      persistAmountsHidden(true).pipe(Effect.andThen(loadAmountDisplayPrefs)),
    );
    expect(result).toEqual({ unit: "sat", hidden: true });
  });

  it("falls back to the default unit for an unparseable stored value", async () => {
    const result = await run(
      Effect.gen(function* () {
        const kv = yield* KeyValueStorage.KeyValueStore;
        yield* Effect.orDie(kv.set(DISPLAY_UNIT_STORAGE_KEY, "doubloons"));
        return yield* loadAmountDisplayPrefs;
      }),
    );
    expect(result.unit).toBe("sat");
  });
});

describe("wallet warning dismissal", () => {
  it("defaults to not dismissed", async () => {
    await expect(run(loadWalletWarningDismissed)).resolves.toBe(false);
  });

  it("round-trips dismissal, including the reset to false", async () => {
    const afterDismiss = await run(
      persistWalletWarningDismissed(true).pipe(Effect.andThen(loadWalletWarningDismissed)),
    );
    expect(afterDismiss).toBe(true);

    const afterReset = await run(
      persistWalletWarningDismissed(true).pipe(
        Effect.andThen(persistWalletWarningDismissed(false)),
        Effect.andThen(loadWalletWarningDismissed),
      ),
    );
    expect(afterReset).toBe(false);
  });
});
