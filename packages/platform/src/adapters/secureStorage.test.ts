import { SecureStorageError } from "@linky/core";
import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";

import type { SecureStoreNativeModule } from "./secureStorage";
import { makeSecureStorage } from "./secureStorage";

/** In-memory stand-in for expo-secure-store. */
const memoryNative = (): SecureStoreNativeModule & { readonly store: Map<string, string> } => {
  const store = new Map<string, string>();
  return {
    store,
    getItemAsync: (key) => Promise.resolve(store.get(key) ?? null),
    setItemAsync: (key, value) => {
      store.set(key, value);
      return Promise.resolve();
    },
    deleteItemAsync: (key) => {
      store.delete(key);
      return Promise.resolve();
    },
  };
};

const failingNative: SecureStoreNativeModule = {
  getItemAsync: () => Promise.reject(new Error("keychain locked")),
  setItemAsync: () => Promise.reject(new Error("keychain locked")),
  deleteItemAsync: () => Promise.reject(new Error("keychain locked")),
};

describe("makeSecureStorage", () => {
  it("round-trips a value and treats absence as Option.none", async () => {
    const storage = makeSecureStorage(memoryNative());

    expect(await Effect.runPromise(storage.get("missing"))).toEqual(Option.none());

    await Effect.runPromise(storage.set("k", "v"));
    expect(await Effect.runPromise(storage.get("k"))).toEqual(Option.some("v"));

    await Effect.runPromise(storage.delete("k"));
    expect(await Effect.runPromise(storage.get("k"))).toEqual(Option.none());
  });

  it("deleting a missing key succeeds (idempotent)", async () => {
    const storage = makeSecureStorage(memoryNative());
    await expect(Effect.runPromise(storage.delete("never-set"))).resolves.toBeUndefined();
  });

  it.each([
    ["get", (s: ReturnType<typeof makeSecureStorage>) => s.get("k")],
    ["set", (s: ReturnType<typeof makeSecureStorage>) => s.set("k", "v")],
    ["delete", (s: ReturnType<typeof makeSecureStorage>) => s.delete("k")],
  ] as const)("maps native %s rejections to SecureStorageError", async (operation, run) => {
    const storage = makeSecureStorage(failingNative);
    const failure = await Effect.runPromise(Effect.flip(run(storage)));

    expect(failure).toBeInstanceOf(SecureStorageError);
    expect(failure.operation).toBe(operation);
    expect(failure.key).toBe("k");
    expect(failure.cause).toEqual(new Error("keychain locked"));
  });
});
