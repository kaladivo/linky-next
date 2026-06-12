/**
 * SyncServerSettingsStore behavior tests (#53) — in-memory KeyValueStore,
 * fully deterministic.
 */
import { Effect, Fiber, Layer, Option, Ref, Stream, TestContext } from "effect";
import { describe, expect, it } from "vitest";

import { KeyValueStorage } from "../../ports/KeyValueStorage.js";
import { awaitCondition } from "../nostr/nostrTestKit.js";
import { syncTestEnvironmentLayer } from "./syncTestKit.js";
import type { SyncServerSettingsService } from "./syncServerSettings.js";
import {
  SYNC_SERVER_DISABLED_STORAGE_KEY,
  SYNC_SERVER_SETTINGS_STORAGE_KEY,
  SyncServerSettingsStore,
  activeSyncServerUrls,
  layerSyncServerSettingsStore,
  normalizeSyncServerUrl,
} from "./syncServerSettings.js";

const DEFAULT_A = "wss://sync-a.test";
const DEFAULT_B = "wss://sync-b.test";
const CUSTOM = "wss://custom-sync.test";

interface Harness {
  readonly store: SyncServerSettingsService;
  readonly kv: KeyValueStorage.KeyValueStore;
}

/** Runs `body` against a fresh store; `seed` pre-populates storage. */
const withStore = (
  options: { readonly seed?: string; readonly seedDisabled?: string },
  body: (harness: Harness) => Effect.Effect<void, unknown>,
): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const kv = yield* Effect.provide(
        KeyValueStorage.KeyValueStore,
        KeyValueStorage.layerMemory,
      );
      if (options.seed !== undefined) {
        yield* kv.set(SYNC_SERVER_SETTINGS_STORAGE_KEY, options.seed);
      }
      if (options.seedDisabled !== undefined) {
        yield* kv.set(SYNC_SERVER_DISABLED_STORAGE_KEY, options.seedDisabled);
      }
      const appLayer = layerSyncServerSettingsStore.pipe(
        Layer.provide(syncTestEnvironmentLayer([DEFAULT_A, DEFAULT_B])),
        Layer.provide(Layer.succeed(KeyValueStorage.KeyValueStore, kv)),
      );
      yield* Effect.gen(function* () {
        const store = yield* SyncServerSettingsStore;
        yield* body({ store, kv });
      }).pipe(Effect.provide(appLayer));
    }).pipe(Effect.provide(TestContext.TestContext)),
  );

const urls = (store: SyncServerSettingsService) =>
  Effect.map(store.settings, (settings) => settings.servers.map((server) => server.url));

const active = (store: SyncServerSettingsService) => Effect.map(store.settings, activeSyncServerUrls);

describe("normalizeSyncServerUrl", () => {
  it("trims, strips trailing slashes, and validates the scheme", () => {
    expect(normalizeSyncServerUrl("  wss://evolu.test  ")).toBe("wss://evolu.test");
    expect(normalizeSyncServerUrl("wss://evolu.test/")).toBe("wss://evolu.test");
    expect(normalizeSyncServerUrl("ws://localhost:4000")).toBe("ws://localhost:4000");
    expect(normalizeSyncServerUrl("WSS://EVOLU.TEST")).toBe("WSS://EVOLU.TEST");
    expect(normalizeSyncServerUrl("https://evolu.test")).toBeNull();
    expect(normalizeSyncServerUrl("evolu.test")).toBeNull();
    expect(normalizeSyncServerUrl("wss://")).toBeNull();
    expect(normalizeSyncServerUrl("")).toBeNull();
  });
});

describe("loading", () => {
  it("falls back to the environment defaults when nothing is persisted", async () => {
    await withStore({}, ({ store }) =>
      Effect.gen(function* () {
        expect(yield* urls(store)).toStrictEqual([DEFAULT_A, DEFAULT_B]);
        expect(yield* active(store)).toStrictEqual([DEFAULT_A, DEFAULT_B]);
      }),
    );
  });

  it("loads the persisted list and disabled set", async () => {
    await withStore(
      {
        seed: JSON.stringify([CUSTOM, DEFAULT_A]),
        seedDisabled: JSON.stringify([DEFAULT_A]),
      },
      ({ store }) =>
        Effect.gen(function* () {
          const settings = yield* store.settings;
          expect(settings.servers).toStrictEqual([
            { url: CUSTOM, enabled: true },
            { url: DEFAULT_A, enabled: false },
          ]);
          expect(activeSyncServerUrls(settings)).toStrictEqual([CUSTOM]);
        }),
    );
  });

  it("falls back to defaults on undecodable or invalid persisted content", async () => {
    await withStore({ seed: "not json" }, ({ store }) =>
      Effect.gen(function* () {
        expect(yield* urls(store)).toStrictEqual([DEFAULT_A, DEFAULT_B]);
      }),
    );
    await withStore({ seed: JSON.stringify(["https://not-a-server.test", ""]) }, ({ store }) =>
      Effect.gen(function* () {
        expect(yield* urls(store)).toStrictEqual([DEFAULT_A, DEFAULT_B]);
      }),
    );
  });
});

describe("addServer", () => {
  it("normalizes, appends enabled, and persists", async () => {
    await withStore({}, ({ store, kv }) =>
      Effect.gen(function* () {
        const settings = yield* store.addServer(`  ${CUSTOM}/  `);
        expect(settings.servers).toStrictEqual([
          { url: DEFAULT_A, enabled: true },
          { url: DEFAULT_B, enabled: true },
          { url: CUSTOM, enabled: true },
        ]);
        const persisted = yield* kv.get(SYNC_SERVER_SETTINGS_STORAGE_KEY);
        expect(Option.getOrNull(persisted)).toBe(JSON.stringify([DEFAULT_A, DEFAULT_B, CUSTOM]));
      }),
    );
  });

  it("is a case-insensitive no-op for an already-listed URL (PoC behavior)", async () => {
    await withStore({}, ({ store, kv }) =>
      Effect.gen(function* () {
        const settings = yield* store.addServer(DEFAULT_A.toUpperCase());
        expect(settings.servers.map((server) => server.url)).toStrictEqual([
          DEFAULT_A,
          DEFAULT_B,
        ]);
        // No-op edits do not write storage (defaults stay config-only).
        expect(Option.isNone(yield* kv.get(SYNC_SERVER_SETTINGS_STORAGE_KEY))).toBe(true);
      }),
    );
  });

  it("rejects non-WebSocket URLs", async () => {
    await withStore({}, ({ store }) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(store.addServer("https://evolu.test"));
        expect(error._tag).toBe("InvalidSyncServerUrlError");
        const empty = yield* Effect.flip(store.addServer("   "));
        expect(empty._tag).toBe("InvalidSyncServerUrlError");
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
            Ref.update(seen, (lists) => [...lists, settings.servers.map((s) => s.url)]),
          ),
        );
        yield* awaitCondition(
          Effect.map(Ref.get(seen), (lists) => lists.length >= 1),
          "initial replay",
        );
        yield* store.addServer(CUSTOM);
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

describe("removeServer", () => {
  it("removes, persists, and clears the URL from the disabled set", async () => {
    await withStore(
      { seed: JSON.stringify([DEFAULT_A, DEFAULT_B]), seedDisabled: JSON.stringify([DEFAULT_B]) },
      ({ store, kv }) =>
        Effect.gen(function* () {
          const settings = yield* store.removeServer(DEFAULT_B);
          expect(settings.servers).toStrictEqual([{ url: DEFAULT_A, enabled: true }]);
          const persisted = yield* kv.get(SYNC_SERVER_SETTINGS_STORAGE_KEY);
          expect(Option.getOrNull(persisted)).toBe(JSON.stringify([DEFAULT_A]));
          const disabled = yield* kv.get(SYNC_SERVER_DISABLED_STORAGE_KEY);
          expect(Option.getOrNull(disabled)).toBe(JSON.stringify([]));
        }),
    );
  });

  it("keeps at least one server (LastSyncServerError, PoC min-one rule)", async () => {
    await withStore({ seed: JSON.stringify([CUSTOM]) }, ({ store }) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(store.removeServer(CUSTOM));
        expect(error._tag).toBe("LastSyncServerError");
        expect(yield* urls(store)).toStrictEqual([CUSTOM]);
      }),
    );
  });

  it("is a no-op for a URL that is not listed", async () => {
    await withStore({}, ({ store }) =>
      Effect.gen(function* () {
        const settings = yield* store.removeServer(CUSTOM);
        expect(settings.servers.map((server) => server.url)).toStrictEqual([
          DEFAULT_A,
          DEFAULT_B,
        ]);
      }),
    );
  });

  it("survives a reload: a removed default stays removed (PoC divergence — per-URL)", async () => {
    await withStore({}, ({ store, kv }) =>
      Effect.gen(function* () {
        yield* store.removeServer(DEFAULT_B);
        // Simulate the next app start over the same storage.
        const reloadedLayer = layerSyncServerSettingsStore.pipe(
          Layer.provide(syncTestEnvironmentLayer([DEFAULT_A, DEFAULT_B])),
          Layer.provide(Layer.succeed(KeyValueStorage.KeyValueStore, kv)),
        );
        yield* Effect.gen(function* () {
          const reloaded = yield* SyncServerSettingsStore;
          expect(yield* urls(reloaded)).toStrictEqual([DEFAULT_A]);
        }).pipe(Effect.provide(reloadedLayer));
      }),
    );
  });
});

describe("setServerEnabled", () => {
  it("disables and re-enables without changing the list, persisting the set", async () => {
    await withStore({}, ({ store, kv }) =>
      Effect.gen(function* () {
        const disabledSettings = yield* store.setServerEnabled(DEFAULT_A, false);
        expect(disabledSettings.servers).toStrictEqual([
          { url: DEFAULT_A, enabled: false },
          { url: DEFAULT_B, enabled: true },
        ]);
        expect(activeSyncServerUrls(disabledSettings)).toStrictEqual([DEFAULT_B]);
        expect(
          Option.getOrNull(yield* kv.get(SYNC_SERVER_DISABLED_STORAGE_KEY)),
        ).toBe(JSON.stringify([DEFAULT_A]));

        const enabledSettings = yield* store.setServerEnabled(DEFAULT_A, true);
        expect(activeSyncServerUrls(enabledSettings)).toStrictEqual([DEFAULT_A, DEFAULT_B]);
        expect(
          Option.getOrNull(yield* kv.get(SYNC_SERVER_DISABLED_STORAGE_KEY)),
        ).toBe(JSON.stringify([]));
      }),
    );
  });

  it("allows disabling every server (sync off; list never empties)", async () => {
    await withStore({}, ({ store }) =>
      Effect.gen(function* () {
        yield* store.setServerEnabled(DEFAULT_A, false);
        const settings = yield* store.setServerEnabled(DEFAULT_B, false);
        expect(activeSyncServerUrls(settings)).toStrictEqual([]);
        expect(settings.servers).toHaveLength(2);
      }),
    );
  });

  it("survives a reload: the disabled set is restored", async () => {
    await withStore({}, ({ store, kv }) =>
      Effect.gen(function* () {
        yield* store.setServerEnabled(DEFAULT_B, false);
        const reloadedLayer = layerSyncServerSettingsStore.pipe(
          Layer.provide(syncTestEnvironmentLayer([DEFAULT_A, DEFAULT_B])),
          Layer.provide(Layer.succeed(KeyValueStorage.KeyValueStore, kv)),
        );
        yield* Effect.gen(function* () {
          const reloaded = yield* SyncServerSettingsStore;
          expect(yield* active(reloaded)).toStrictEqual([DEFAULT_A]);
        }).pipe(Effect.provide(reloadedLayer));
      }),
    );
  });

  it("is a no-op for a URL that is not listed", async () => {
    await withStore({}, ({ store }) =>
      Effect.gen(function* () {
        const settings = yield* store.setServerEnabled(CUSTOM, false);
        expect(activeSyncServerUrls(settings)).toStrictEqual([DEFAULT_A, DEFAULT_B]);
      }),
    );
  });
});
