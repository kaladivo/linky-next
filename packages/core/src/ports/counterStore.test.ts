/**
 * CounterStore port semantics: defaults, clamping, monotonic ratchet, key
 * normalization (PoC-compatible), per-keyset lock serialization, and the
 * KeyValueStorage-backed Layer.
 */
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import {
  COUNTER_KEY_PREFIX,
  CounterStore,
  CounterStoreKeyValue,
  CounterStoreMemory,
  type KeysetRef,
  counterStoreKey,
} from "./CounterStore.js";
import { KeyValueStorage } from "./KeyValueStorage.js";

const ref: KeysetRef = {
  mintUrl: "https://testnut.cashu.space",
  unit: "sat",
  keysetId: "009a1f293253e41e",
};

const run = <A, E>(program: Effect.Effect<A, E, CounterStore>): Promise<A> =>
  Effect.runPromise(program.pipe(Effect.provide(CounterStoreMemory)));

describe("counterStoreKey", () => {
  it("normalizes mint URLs and defaults the unit like the PoC", () => {
    const canonical = counterStoreKey(COUNTER_KEY_PREFIX, ref);
    expect(canonical).toBe(
      "linky.cashu.detCounter.v1:https%3A%2F%2Ftestnut.cashu.space:sat:009a1f293253e41e",
    );
    expect(
      counterStoreKey(COUNTER_KEY_PREFIX, {
        mintUrl: " https://testnut.cashu.space// ",
        unit: " ",
        keysetId: "009a1f293253e41e",
      }),
    ).toBe(canonical);
  });
});

describe("CounterStoreMemory", () => {
  it("starts at 0 and bumps by used slots", async () => {
    const result = await run(
      Effect.gen(function* () {
        const store = yield* CounterStore;
        const initial = yield* store.getCounter(ref);
        yield* store.bumpCounter(ref, 3);
        yield* store.bumpCounter(ref, 2);
        const after = yield* store.getCounter(ref);
        return { initial, after };
      }),
    );
    expect(result).toEqual({ initial: 0, after: 5 });
  });

  it("ensureCounterAtLeast never lowers the counter", async () => {
    const result = await run(
      Effect.gen(function* () {
        const store = yield* CounterStore;
        yield* store.ensureCounterAtLeast(ref, 10);
        const raised = yield* store.getCounter(ref);
        yield* store.ensureCounterAtLeast(ref, 4);
        const stillRaised = yield* store.getCounter(ref);
        return { raised, stillRaised };
      }),
    );
    expect(result).toEqual({ raised: 10, stillRaised: 10 });
  });

  it("clamps garbage inputs to non-negative integers", async () => {
    const result = await run(
      Effect.gen(function* () {
        const store = yield* CounterStore;
        yield* store.bumpCounter(ref, -5);
        yield* store.bumpCounter(ref, 2.9);
        yield* store.bumpCounter(ref, Number.NaN);
        return yield* store.getCounter(ref);
      }),
    );
    expect(result).toBe(2);
  });

  it("keeps restore cursors separate from counters", async () => {
    const result = await run(
      Effect.gen(function* () {
        const store = yield* CounterStore;
        yield* store.setRestoreCursor(ref, 42);
        const cursor = yield* store.getRestoreCursor(ref);
        const counter = yield* store.getCounter(ref);
        return { cursor, counter };
      }),
    );
    expect(result).toEqual({ cursor: 42, counter: 0 });
  });

  it("treats trailing-slash mint URLs as the same counter lane", async () => {
    const result = await run(
      Effect.gen(function* () {
        const store = yield* CounterStore;
        yield* store.bumpCounter(ref, 7);
        return yield* store.getCounter({ ...ref, mintUrl: `${ref.mintUrl}/` });
      }),
    );
    expect(result).toBe(7);
  });

  it("serializes counter-consuming sections per keyset (no interleaving)", async () => {
    const observed = await run(
      Effect.gen(function* () {
        const store = yield* CounterStore;
        const criticalSection = Effect.gen(function* () {
          const before = yield* store.getCounter(ref);
          // Yield a few times: without the lock, both fibers would read the
          // same counter before either bumps.
          yield* Effect.yieldNow();
          yield* Effect.yieldNow();
          yield* store.bumpCounter(ref, 1);
          return before;
        });
        return yield* Effect.all(
          [
            store.withCounterLock(ref, criticalSection),
            store.withCounterLock(ref, criticalSection),
          ],
          { concurrency: 2 },
        );
      }),
    );
    expect([...observed].sort()).toEqual([0, 1]);
  });
});

describe("CounterStoreKeyValue", () => {
  it("persists counters through the KeyValueStorage port", async () => {
    const kvLayer = KeyValueStorage.layerMemory;
    const layer = CounterStoreKeyValue.pipe(Layer.provideMerge(kvLayer));

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* CounterStore;
        yield* store.bumpCounter(ref, 9);
        yield* store.setRestoreCursor(ref, 4);
        const kv = yield* KeyValueStorage.KeyValueStore;
        const raw = yield* kv.get(counterStoreKey(COUNTER_KEY_PREFIX, ref));
        const counter = yield* store.getCounter(ref);
        const cursor = yield* store.getRestoreCursor(ref);
        return { raw, counter, cursor };
      }).pipe(Effect.provide(layer)),
    );

    expect(result.counter).toBe(9);
    expect(result.cursor).toBe(4);
    expect(result.raw._tag).toBe("Some");
    if (result.raw._tag === "Some") expect(result.raw.value).toBe("9");
  });
});
