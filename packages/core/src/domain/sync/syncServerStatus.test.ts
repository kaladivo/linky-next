/**
 * SyncServerStatusStore behavior tests (#53) — fake relay network as the
 * WebSocket seam (probes only use `connect`), in-memory KeyValueStore.
 */
import { Effect, Layer, TestContext } from "effect";
import { describe, expect, it } from "vitest";

import { KeyValueStorage } from "../../ports/KeyValueStorage.js";
import { makeFakeRelayNetwork } from "../nostr/fakeRelay.js";
import type { FakeRelayNetwork } from "../nostr/fakeRelay.js";
import { awaitCondition } from "../nostr/nostrTestKit.js";
import type { SyncServerSettingsService } from "./syncServerSettings.js";
import { SyncServerSettingsStore, layerSyncServerSettingsStore } from "./syncServerSettings.js";
import { syncTestEnvironmentLayer } from "./syncTestKit.js";
import type { SyncServerStatusService } from "./syncServerStatus.js";
import {
  SyncServerStatusStore,
  layerSyncServerStatusStore,
  overallSyncServerStatus,
} from "./syncServerStatus.js";

const SERVER_A = "wss://sync-a.test";
const SERVER_B = "wss://sync-b.test";
const CUSTOM = "wss://custom-sync.test";

interface Harness {
  readonly status: SyncServerStatusService;
  readonly settings: SyncServerSettingsService;
  readonly network: FakeRelayNetwork;
}

const withStatus = (body: (harness: Harness) => Effect.Effect<void, unknown>): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const network = yield* makeFakeRelayNetwork;
      const settingsLayer = layerSyncServerSettingsStore.pipe(
        Layer.provide(syncTestEnvironmentLayer([SERVER_A, SERVER_B])),
        Layer.provide(KeyValueStorage.layerMemory),
      );
      const appLayer = layerSyncServerStatusStore().pipe(
        Layer.provide(network.transport),
        Layer.provideMerge(settingsLayer),
      );
      yield* Effect.gen(function* () {
        const status = yield* SyncServerStatusStore;
        const settings = yield* SyncServerSettingsStore;
        yield* body({ status, settings, network });
      }).pipe(Effect.provide(appLayer));
    }).pipe(Effect.provide(TestContext.TestContext)),
  );

describe("overallSyncServerStatus", () => {
  it("connected beats checking beats disconnected; empty map is disconnected", () => {
    const map = (entries: ReadonlyArray<readonly [string, "checking" | "connected" | "disconnected"]>) =>
      new Map(entries);
    expect(overallSyncServerStatus(map([]))).toBe("disconnected");
    expect(overallSyncServerStatus(map([["a", "disconnected"]]))).toBe("disconnected");
    expect(overallSyncServerStatus(map([["a", "disconnected"], ["b", "checking"]]))).toBe(
      "checking",
    );
    expect(
      overallSyncServerStatus(map([["a", "disconnected"], ["b", "connected"]])),
    ).toBe("connected");
  });
});

describe("SyncServerStatusStore", () => {
  it("seeds every enabled server as checking", async () => {
    await withStatus(({ status }) =>
      Effect.gen(function* () {
        const statuses = yield* status.statuses;
        expect(statuses.get(SERVER_A)).toBe("checking");
        expect(statuses.get(SERVER_B)).toBe("checking");
      }),
    );
  });

  it("refresh marks reachable servers connected and unreachable disconnected", async () => {
    await withStatus(({ status, network }) =>
      Effect.gen(function* () {
        const relayB = yield* network.relay(SERVER_B);
        yield* relayB.setOnline(false);
        yield* status.refresh;
        const statuses = yield* status.statuses;
        expect(statuses.get(SERVER_A)).toBe("connected");
        expect(statuses.get(SERVER_B)).toBe("disconnected");
      }),
    );
  });

  it("drops disabled servers from the map and picks up new ones as checking", async () => {
    await withStatus(({ status, settings }) =>
      Effect.gen(function* () {
        yield* settings.setServerEnabled(SERVER_B, false);
        yield* awaitCondition(
          Effect.map(status.statuses, (statuses) => !statuses.has(SERVER_B)),
          "disabled server dropped",
        );
        yield* settings.addServer(CUSTOM);
        yield* awaitCondition(
          Effect.map(status.statuses, (statuses) => statuses.get(CUSTOM) === "checking"),
          "new server appears as checking",
        );
        yield* status.refresh;
        const statuses = yield* status.statuses;
        expect(statuses.get(CUSTOM)).toBe("connected");
        expect(statuses.has(SERVER_B)).toBe(false);
      }),
    );
  });

  it("refresh with no active servers leaves an empty map (overall disconnected)", async () => {
    await withStatus(({ status, settings }) =>
      Effect.gen(function* () {
        yield* settings.setServerEnabled(SERVER_A, false);
        yield* settings.setServerEnabled(SERVER_B, false);
        yield* status.refresh;
        const statuses = yield* status.statuses;
        expect(statuses.size).toBe(0);
        expect(overallSyncServerStatus(statuses)).toBe("disconnected");
      }),
    );
  });
});
