/**
 * Locale persistence workflows against the in-memory KeyValueStore layer —
 * exactly how the production code runs them, minus AsyncStorage.
 */
import { KeyValueStorage } from "@linky/core";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { LOCALE_STORAGE_KEY, loadPersistedLocale, persistLocale } from "./localePreference";

const run = <A>(effect: Effect.Effect<A, never, KeyValueStorage.KeyValueStore>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(KeyValueStorage.layerMemory)));

describe("localePreference", () => {
  it("returns null when nothing is persisted", async () => {
    await expect(run(loadPersistedLocale)).resolves.toBeNull();
  });

  it("round-trips a persisted locale", async () => {
    const result = await run(persistLocale("cs").pipe(Effect.andThen(loadPersistedLocale)));
    expect(result).toBe("cs");
  });

  it("returns the raw stored string (validation belongs to resolveLocale)", async () => {
    const result = await run(
      Effect.gen(function* () {
        const kv = yield* KeyValueStorage.KeyValueStore;
        yield* Effect.orDie(kv.set(LOCALE_STORAGE_KEY, "klingon"));
        return yield* loadPersistedLocale;
      }),
    );
    expect(result).toBe("klingon");
  });
});
