/**
 * RelaySettingsStore behavior tests (#31) — fake relay network + in-memory
 * KeyValueStore, fully deterministic.
 */
import { Effect, Fiber, Layer, Option, Ref, Stream, TestContext } from "effect";
import { describe, expect, it } from "vitest";

import { KeyValueStorage } from "../../ports/KeyValueStorage.js";
import { makeFakeRelayNetwork } from "./fakeRelay.js";
import type { RelayPoolService } from "./RelayPool.js";
import { RelayPool, layerRelayPool } from "./RelayPool.js";
import type { RelaySettingsStoreService } from "./relaySettings.js";
import {
  RELAY_SETTINGS_STORAGE_KEY,
  RelaySettingsStore,
  isValidRelayUrl,
  layerRelaySettingsStore,
} from "./relaySettings.js";
import { awaitCondition, testEnvironmentLayer } from "./nostrTestKit.js";

const DEFAULT_A = "wss://default-a.test";
const DEFAULT_B = "wss://default-b.test";
const CUSTOM = "wss://custom.test";

interface Harness {
  readonly store: RelaySettingsStoreService;
  readonly pool: RelayPoolService;
  readonly kv: KeyValueStorage.KeyValueStore;
}

/** Runs `body` against a fresh store; `seed` pre-populates storage. */
const withStore = (
  options: { readonly seed?: string },
  body: (harness: Harness) => Effect.Effect<void, unknown>,
): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const network = yield* makeFakeRelayNetwork;
      // The KV service is built up front so seeding happens before the
      // store layer loads, and so the reload test can reuse the same store.
      const kv = yield* Effect.provide(
        KeyValueStorage.KeyValueStore,
        KeyValueStorage.layerMemory,
      );
      if (options.seed !== undefined) yield* kv.set(RELAY_SETTINGS_STORAGE_KEY, options.seed);
      const environmentLayer = testEnvironmentLayer([DEFAULT_A, DEFAULT_B]);
      const poolLayer = layerRelayPool().pipe(
        Layer.provide(network.transport),
        Layer.provide(environmentLayer),
      );
      // One layer tree → ONE pool shared by the store and the assertions.
      const appLayer = layerRelaySettingsStore.pipe(
        Layer.provide(environmentLayer),
        Layer.provideMerge(poolLayer),
        Layer.provide(Layer.succeed(KeyValueStorage.KeyValueStore, kv)),
      );
      yield* Effect.gen(function* () {
        const store = yield* RelaySettingsStore;
        const pool = yield* RelayPool;
        yield* body({ store, pool, kv });
      }).pipe(Effect.provide(appLayer));
    }).pipe(Effect.provide(TestContext.TestContext)),
  );

const urls = (store: RelaySettingsStoreService) =>
  Effect.map(store.settings, (settings) => settings.relayUrls);

describe("isValidRelayUrl", () => {
  it("accepts wss/ws URLs and rejects everything else", () => {
    expect(isValidRelayUrl("wss://relay.damus.io")).toBe(true);
    expect(isValidRelayUrl("ws://localhost:7777")).toBe(true);
    expect(isValidRelayUrl("WSS://RELAY.TEST")).toBe(true);
    expect(isValidRelayUrl("https://relay.damus.io")).toBe(false);
    expect(isValidRelayUrl("relay.damus.io")).toBe(false);
    expect(isValidRelayUrl("wss://")).toBe(false);
    expect(isValidRelayUrl("")).toBe(false);
  });
});

describe("loading", () => {
  it("falls back to the environment defaults when nothing is persisted", async () => {
    await withStore({}, ({ store, pool }) =>
      Effect.gen(function* () {
        expect(yield* urls(store)).toStrictEqual([DEFAULT_A, DEFAULT_B]);
        expect(yield* pool.relayUrls).toStrictEqual([DEFAULT_A, DEFAULT_B]);
      }),
    );
  });

  it("loads the persisted list and applies it to the pool", async () => {
    await withStore({ seed: JSON.stringify([CUSTOM, DEFAULT_A]) }, ({ store, pool }) =>
      Effect.gen(function* () {
        expect(yield* urls(store)).toStrictEqual([CUSTOM, DEFAULT_A]);
        expect(yield* pool.relayUrls).toStrictEqual([CUSTOM, DEFAULT_A]);
        // The removed default has no status entry; the persisted set does.
        const status = yield* pool.status;
        expect(status.has(DEFAULT_B)).toBe(false);
        expect(status.has(CUSTOM)).toBe(true);
      }),
    );
  });

  it("falls back to defaults on undecodable or invalid persisted content", async () => {
    await withStore({ seed: "not json" }, ({ store }) =>
      Effect.gen(function* () {
        expect(yield* urls(store)).toStrictEqual([DEFAULT_A, DEFAULT_B]);
      }),
    );
    await withStore({ seed: JSON.stringify(["https://not-a-relay.test", ""]) }, ({ store }) =>
      Effect.gen(function* () {
        expect(yield* urls(store)).toStrictEqual([DEFAULT_A, DEFAULT_B]);
      }),
    );
  });
});

describe("addRelay", () => {
  it("trims, appends, persists, and reconciles the pool", async () => {
    await withStore({}, ({ store, pool, kv }) =>
      Effect.gen(function* () {
        const settings = yield* store.addRelay(`  ${CUSTOM}  `);
        expect(settings.relayUrls).toStrictEqual([DEFAULT_A, DEFAULT_B, CUSTOM]);
        expect(yield* pool.relayUrls).toStrictEqual([DEFAULT_A, DEFAULT_B, CUSTOM]);
        yield* awaitCondition(
          Effect.map(pool.status, (status) => status.get(CUSTOM) === "connected"),
          "new relay connected",
        );
        const persisted = yield* kv.get(RELAY_SETTINGS_STORAGE_KEY);
        expect(Option.getOrNull(persisted)).toBe(JSON.stringify([DEFAULT_A, DEFAULT_B, CUSTOM]));
      }),
    );
  });

  it("is a no-op for an already-listed URL (PoC behavior)", async () => {
    await withStore({}, ({ store, kv }) =>
      Effect.gen(function* () {
        const settings = yield* store.addRelay(DEFAULT_A);
        expect(settings.relayUrls).toStrictEqual([DEFAULT_A, DEFAULT_B]);
        // No-op edits do not write storage (defaults stay config-only).
        expect(Option.isNone(yield* kv.get(RELAY_SETTINGS_STORAGE_KEY))).toBe(true);
      }),
    );
  });

  it("rejects non-WebSocket URLs", async () => {
    await withStore({}, ({ store }) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(store.addRelay("https://relay.damus.io"));
        expect(error._tag).toBe("InvalidRelayUrlError");
        const empty = yield* Effect.flip(store.addRelay("   "));
        expect(empty._tag).toBe("InvalidRelayUrlError");
        expect(yield* urls(store)).toStrictEqual([DEFAULT_A, DEFAULT_B]);
      }),
    );
  });

  it("emits the new settings on the changes stream", async () => {
    await withStore({}, ({ store }) =>
      Effect.gen(function* () {
        const seen = yield* Ref.make<ReadonlyArray<ReadonlyArray<string>>>([]);
        const collector = yield* Effect.fork(
          Stream.runForEach(store.changes, (settings) =>
            Ref.update(seen, (lists) => [...lists, settings.relayUrls]),
          ),
        );
        // Wait for the replayed current value before mutating, so the
        // subscription is provably active.
        yield* awaitCondition(
          Effect.map(Ref.get(seen), (lists) => lists.length >= 1),
          "initial replay",
        );
        yield* store.addRelay(CUSTOM);
        yield* awaitCondition(
          Effect.map(Ref.get(seen), (lists) => lists.length >= 2),
          "change emitted",
        );
        const lists = yield* Ref.get(seen);
        expect(lists[0]).toStrictEqual([DEFAULT_A, DEFAULT_B]); // replayed current
        expect(lists[lists.length - 1]).toStrictEqual([DEFAULT_A, DEFAULT_B, CUSTOM]);
        yield* Fiber.interrupt(collector);
      }),
    );
  });
});

describe("removeRelay", () => {
  it("removes, persists, and drops the relay from the pool", async () => {
    await withStore({}, ({ store, pool, kv }) =>
      Effect.gen(function* () {
        const settings = yield* store.removeRelay(DEFAULT_B);
        expect(settings.relayUrls).toStrictEqual([DEFAULT_A]);
        expect(yield* pool.relayUrls).toStrictEqual([DEFAULT_A]);
        expect((yield* pool.status).has(DEFAULT_B)).toBe(false);
        const persisted = yield* kv.get(RELAY_SETTINGS_STORAGE_KEY);
        expect(Option.getOrNull(persisted)).toBe(JSON.stringify([DEFAULT_A]));
      }),
    );
  });

  it("keeps at least one relay (LastRelayError)", async () => {
    await withStore({ seed: JSON.stringify([CUSTOM]) }, ({ store, pool }) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(store.removeRelay(CUSTOM));
        expect(error._tag).toBe("LastRelayError");
        expect(yield* urls(store)).toStrictEqual([CUSTOM]);
        expect(yield* pool.relayUrls).toStrictEqual([CUSTOM]);
      }),
    );
  });

  it("is a no-op for a URL that is not listed", async () => {
    await withStore({}, ({ store }) =>
      Effect.gen(function* () {
        const settings = yield* store.removeRelay(CUSTOM);
        expect(settings.relayUrls).toStrictEqual([DEFAULT_A, DEFAULT_B]);
      }),
    );
  });

  it("survives a reload: a removed default stays removed", async () => {
    await withStore({}, ({ store, kv }) =>
      Effect.gen(function* () {
        yield* store.removeRelay(DEFAULT_B);
        // Simulate the next app start over the same storage.
        const network = yield* makeFakeRelayNetwork;
        const poolLayer = layerRelayPool().pipe(
          Layer.provide(network.transport),
          Layer.provide(testEnvironmentLayer([DEFAULT_A, DEFAULT_B])),
        );
        const reloadedLayer = layerRelaySettingsStore.pipe(
          Layer.provide(poolLayer),
          Layer.provide(testEnvironmentLayer([DEFAULT_A, DEFAULT_B])),
          Layer.provide(Layer.succeed(KeyValueStorage.KeyValueStore, kv)),
        );
        yield* Effect.gen(function* () {
          const reloaded = yield* RelaySettingsStore;
          expect(yield* urls(reloaded)).toStrictEqual([DEFAULT_A]);
        }).pipe(Effect.provide(reloadedLayer));
      }),
    );
  });
});
