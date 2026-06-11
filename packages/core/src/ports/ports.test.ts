/**
 * Convention tests for the port layer. These double as executable
 * documentation for README.md: how to write a workflow against ports, how to
 * build in-memory test Layers, how typed errors surface, and how time is
 * controlled with TestClock instead of a custom port.
 */
import { Clock, Effect, Encoding, Layer, Option, TestClock, TestContext } from "effect";
import { describe, expect, it } from "vitest";

import { KeyValueStorage, Randomness, SecureStorage, SecureStorageError } from "../index.js";

// ---------------------------------------------------------------------------
// A tiny example workflow (the kind of code src/domain/ will be full of).
// It depends on two ports; the dependencies show up in the R channel and the
// typed errors in the E channel — all inferred.
// ---------------------------------------------------------------------------

const IDENTITY_KEY = "identity.secretKey";

const loadOrCreateIdentityKey = Effect.gen(function* () {
  const storage = yield* SecureStorage;
  const existing = yield* storage.get(IDENTITY_KEY);
  if (Option.isSome(existing)) {
    return existing.value;
  }
  const randomness = yield* Randomness;
  const bytes = yield* randomness.nextBytes(32);
  const encoded = Encoding.encodeHex(bytes);
  yield* storage.set(IDENTITY_KEY, encoded);
  return encoded;
});

// ---------------------------------------------------------------------------
// In-memory test Layers — the convention every core test follows.
// ---------------------------------------------------------------------------

/** SecureStorage backed by a Map. One Map per Layer construction. */
const SecureStorageMemory = Layer.sync(SecureStorage, () => {
  const store = new Map<string, string>();
  return {
    get: (key) => Effect.sync(() => Option.fromNullable(store.get(key))),
    set: (key, value) =>
      Effect.sync(() => {
        store.set(key, value);
      }),
    delete: (key) =>
      Effect.sync(() => {
        store.delete(key);
      }),
  };
});

/** Deterministic "randomness": call n yields bytes n, n+1, n+2, ... */
const RandomnessDeterministic = Layer.sync(Randomness, () => {
  let calls = 0;
  return {
    nextBytes: (byteCount) =>
      Effect.sync(() => {
        const bytes = new Uint8Array(byteCount);
        for (let i = 0; i < byteCount; i++) {
          bytes[i] = (calls + i) % 256;
        }
        calls += 1;
        return bytes;
      }),
  };
});

/** A SecureStorage whose every operation fails — for error-path tests. */
const SecureStorageUnavailable = Layer.succeed(SecureStorage, {
  get: (key) =>
    Effect.fail(new SecureStorageError({ operation: "get", key, cause: "keychain locked" })),
  set: (key, _value) =>
    Effect.fail(new SecureStorageError({ operation: "set", key, cause: "keychain locked" })),
  delete: (key) =>
    Effect.fail(new SecureStorageError({ operation: "delete", key, cause: "keychain locked" })),
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("example workflow against in-memory port Layers", () => {
  it("creates a key once and returns the stored one afterwards", async () => {
    const program = Effect.gen(function* () {
      const first = yield* loadOrCreateIdentityKey;
      const second = yield* loadOrCreateIdentityKey;
      return { first, second };
    }).pipe(Effect.provide(Layer.merge(SecureStorageMemory, RandomnessDeterministic)));

    const { first, second } = await Effect.runPromise(program);

    // Deterministic Randomness layer: first call produces bytes 0x00..0x1f.
    expect(first).toBe("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f");
    // Second run hits SecureStorage, not Randomness.
    expect(second).toBe(first);
  });

  it("fresh Layers mean fresh state — tests are isolated by construction", async () => {
    const run = () =>
      Effect.runPromise(
        loadOrCreateIdentityKey.pipe(
          Effect.provide(Layer.merge(SecureStorageMemory, RandomnessDeterministic)),
        ),
      );
    // Each Effect.provide(Layer.sync(...)) builds a new Map and counter.
    expect(await run()).toBe(await run());
  });
});

describe("typed errors", () => {
  it("port failures arrive as tagged errors in the E channel, never thrown", async () => {
    const failure = await Effect.runPromise(
      loadOrCreateIdentityKey.pipe(
        Effect.flip,
        Effect.provide(Layer.merge(SecureStorageUnavailable, RandomnessDeterministic)),
      ),
    );

    expect(failure).toBeInstanceOf(SecureStorageError);
    if (failure._tag !== "SecureStorageError") {
      throw new Error("expected SecureStorageError");
    }
    expect(failure.operation).toBe("get");
    expect(failure.key).toBe(IDENTITY_KEY);
    expect(failure.cause).toBe("keychain locked");
  });

  it("callers recover by tag with catchTag", async () => {
    const recovered = await Effect.runPromise(
      loadOrCreateIdentityKey.pipe(
        Effect.catchTag("SecureStorageError", (error) =>
          Effect.succeed(`fallback after ${error.operation} failure`),
        ),
        Effect.provide(Layer.merge(SecureStorageUnavailable, RandomnessDeterministic)),
      ),
    );

    expect(recovered).toBe("fallback after get failure");
  });
});

describe("KeyValueStorage port (@effect/platform KeyValueStore)", () => {
  it("round-trips preferences through the built-in memory Layer", async () => {
    const program = Effect.gen(function* () {
      const kv = yield* KeyValueStorage.KeyValueStore;
      yield* kv.set("preferredMint", "https://testnut.cashu.space");
      return yield* kv.get("preferredMint");
    }).pipe(Effect.provide(KeyValueStorage.layerMemory));

    expect(await Effect.runPromise(program)).toEqual(Option.some("https://testnut.cashu.space"));
  });
});

describe("time convention: built-in Clock + TestClock, no custom port", () => {
  it("workflows read Clock; tests pin it with TestClock", async () => {
    const program = Effect.gen(function* () {
      yield* TestClock.setTime(1_700_000_000_000);
      return yield* Clock.currentTimeMillis;
    }).pipe(Effect.provide(TestContext.TestContext));

    expect(await Effect.runPromise(program)).toBe(1_700_000_000_000);
  });
});
