import { Error as PlatformError } from "@effect/platform";
import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";

import type { AsyncStorageNativeModule } from "./keyValueStorage";
import { makeKeyValueStorage } from "./keyValueStorage";

/** In-memory stand-in for AsyncStorage. */
const memoryNative = (): AsyncStorageNativeModule => {
  const store = new Map<string, string>();
  return {
    getItem: (key) => Promise.resolve(store.get(key) ?? null),
    setItem: (key, value) => {
      store.set(key, value);
      return Promise.resolve();
    },
    removeItem: (key) => {
      store.delete(key);
      return Promise.resolve();
    },
    clear: () => {
      store.clear();
      return Promise.resolve();
    },
    getAllKeys: () => Promise.resolve([...store.keys()]),
  };
};

const failingNative: AsyncStorageNativeModule = {
  getItem: () => Promise.reject(new Error("disk full")),
  setItem: () => Promise.reject(new Error("disk full")),
  removeItem: () => Promise.reject(new Error("disk full")),
  clear: () => Promise.reject(new Error("disk full")),
  getAllKeys: () => Promise.reject(new Error("disk full")),
};

describe("makeKeyValueStorage", () => {
  it("implements the KeyValueStore contract over the native map", async () => {
    const kv = makeKeyValueStorage(memoryNative());

    expect(await Effect.runPromise(kv.get("k"))).toEqual(Option.none());
    expect(await Effect.runPromise(kv.isEmpty)).toBe(true);

    await Effect.runPromise(kv.set("k", "v"));
    expect(await Effect.runPromise(kv.get("k"))).toEqual(Option.some("v"));
    expect(await Effect.runPromise(kv.has("k"))).toBe(true);
    expect(await Effect.runPromise(kv.size)).toBe(1);

    // Derived combinators from makeStringOnly keep working.
    expect(await Effect.runPromise(kv.modify("k", (v) => v + "!"))).toEqual(Option.some("v!"));
    expect(await Effect.runPromise(kv.get("k"))).toEqual(Option.some("v!"));

    await Effect.runPromise(kv.remove("k"));
    expect(await Effect.runPromise(kv.get("k"))).toEqual(Option.none());

    await Effect.runPromise(kv.set("a", "1").pipe(Effect.zipRight(kv.clear)));
    expect(await Effect.runPromise(kv.size)).toBe(0);
  });

  it("maps native rejections to PlatformError SystemError", async () => {
    const kv = makeKeyValueStorage(failingNative);
    const failure = await Effect.runPromise(Effect.flip(kv.get("k")));

    expect(failure).toBeInstanceOf(PlatformError.SystemError);
    expect(failure._tag).toBe("SystemError");
    if (failure._tag === "SystemError") {
      expect(failure.module).toBe("KeyValueStore");
      expect(failure.method).toBe("get");
      expect(failure.cause).toEqual(new Error("disk full"));
    }
  });
});
