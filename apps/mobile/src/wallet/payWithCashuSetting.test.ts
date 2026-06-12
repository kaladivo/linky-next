/**
 * `settings.pay-with-cashu` setting semantics against the in-memory
 * KeyValueStore layer (issue #46): default-enabled, round-trip, and the
 * PoC's "only an explicit 1 enables a stored value" parse
 * (`getInitialPayWithCashuEnabled`).
 */
import { KeyValueStorage } from "@linky/core";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  PAY_WITH_CASHU_STORAGE_KEY,
  loadPayWithCashuEnabled,
  persistPayWithCashuEnabled,
} from "./payWithCashuSetting";

const run = <A>(effect: Effect.Effect<A, never, KeyValueStorage.KeyValueStore>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(KeyValueStorage.layerMemory)));

describe("pay-with-cashu setting", () => {
  it("defaults to ENABLED when nothing is persisted (PoC default)", async () => {
    await expect(run(loadPayWithCashuEnabled)).resolves.toBe(true);
  });

  it("round-trips disable and re-enable", async () => {
    await expect(
      run(persistPayWithCashuEnabled(false).pipe(Effect.andThen(loadPayWithCashuEnabled))),
    ).resolves.toBe(false);
    await expect(
      run(
        persistPayWithCashuEnabled(false).pipe(
          Effect.andThen(persistPayWithCashuEnabled(true)),
          Effect.andThen(loadPayWithCashuEnabled),
        ),
      ),
    ).resolves.toBe(true);
  });

  it("treats stored values like the PoC parse: blank = default, only '1' enables", async () => {
    const stored = (value: string) =>
      run(
        Effect.gen(function* () {
          const kv = yield* KeyValueStorage.KeyValueStore;
          yield* Effect.orDie(kv.set(PAY_WITH_CASHU_STORAGE_KEY, value));
          return yield* loadPayWithCashuEnabled;
        }),
      );
    await expect(stored("1")).resolves.toBe(true);
    await expect(stored("0")).resolves.toBe(false);
    await expect(stored("  ")).resolves.toBe(true); // blank = unset = default
    await expect(stored("yes")).resolves.toBe(false); // PoC: only "1" enables
  });
});
