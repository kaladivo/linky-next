/**
 * `settings.cashu-autoswap` setting semantics against the in-memory
 * KeyValueStore layer (issue #42): default-enabled, round-trip, and the
 * PoC's "only an explicit 0 disables" parse.
 */
import { KeyValueStorage } from "@linky/core";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  CASHU_AUTOSWAP_STORAGE_KEY,
  loadCashuAutoswapEnabled,
  persistCashuAutoswapEnabled,
} from "./autoswapSetting";

const run = <A>(effect: Effect.Effect<A, never, KeyValueStorage.KeyValueStore>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(KeyValueStorage.layerMemory)));

describe("cashu autoswap setting", () => {
  it("defaults to ENABLED when nothing is persisted (PoC default)", async () => {
    await expect(run(loadCashuAutoswapEnabled)).resolves.toBe(true);
  });

  it("round-trips disable and re-enable", async () => {
    await expect(
      run(persistCashuAutoswapEnabled(false).pipe(Effect.andThen(loadCashuAutoswapEnabled))),
    ).resolves.toBe(false);
    await expect(
      run(
        persistCashuAutoswapEnabled(false).pipe(
          Effect.andThen(persistCashuAutoswapEnabled(true)),
          Effect.andThen(loadCashuAutoswapEnabled),
        ),
      ),
    ).resolves.toBe(true);
  });

  it("treats junk stored values as disabled only for explicit non-'1' (PoC parse)", async () => {
    const stored = (value: string) =>
      run(
        Effect.gen(function* () {
          const kv = yield* KeyValueStorage.KeyValueStore;
          yield* Effect.orDie(kv.set(CASHU_AUTOSWAP_STORAGE_KEY, value));
          return yield* loadCashuAutoswapEnabled;
        }),
      );
    await expect(stored("1")).resolves.toBe(true);
    await expect(stored("0")).resolves.toBe(false);
    await expect(stored("  ")).resolves.toBe(true); // blank = unset = default
    await expect(stored("yes")).resolves.toBe(false); // PoC: only "1" enables
  });
});
