/**
 * SyncServerStatusStore — live per-server reachability for the configured
 * sync servers (#53, `sync.status` in the feature map).
 *
 * ## Why probes, not Evolu state
 *
 * Evolu 7.4.1 keeps a sync-state store internally but does NOT expose it:
 * `subscribeSyncState` / `getSyncState` are commented out upstream pending
 * the owner-API rework, and errors (`subscribeError`) only fire on protocol
 * failures, not connectivity. So, exactly like the PoC
 * (`probeWebSocketConnection`), status is a lightweight WebSocket
 * reachability probe per ENABLED server: open a socket, `connected` once it
 * opens, `disconnected` on failure or timeout. The socket is closed
 * immediately — Evolu's own connections are untouched.
 *
 * The probe rides the `NostrTransport` port (its `connect` resolves exactly
 * when the WebSocket opens and the surrounding scope closes it) — the port
 * is protocol-agnostic until frames are exchanged, and reusing it keeps
 * core free of a second WebSocket seam.
 *
 * ## Shape (mirrors RelayPool's status surface)
 *
 * The map is queryable (`statuses`) and observable (`statusChanges`, a
 * SubscriptionRef-backed stream replaying the current value), covering
 * exactly the ENABLED servers of the current settings. Disabled servers are
 * not probed and have no entry (the PoC showed them as "Offline" without
 * probing); the screen renders them from the settings list. Unlike
 * RelayPool there is no always-on connection loop: `refresh` probes once,
 * and the settings screen drives it on an interval while visible (PoC: 15 s
 * interval, 3.5 s timeout) — no background sockets when no one is looking.
 * A settings edit reconciles the map immediately (removed/disabled servers
 * drop, new ones appear as "checking" until the next refresh).
 */
import type { Duration, Scope } from "effect";
import { Context, Effect, Layer, Stream, SubscriptionRef } from "effect";

import { NostrTransport } from "../../ports/NostrTransport.js";
import { activeSyncServerUrls, SyncServerSettingsStore } from "./syncServerSettings.js";

export type SyncServerStatus = "checking" | "connected" | "disconnected";

export interface SyncServerStatusConfig {
  /** How long a probe may take before the server counts as disconnected. */
  readonly probeTimeout: Duration.DurationInput;
}

/** PoC parity: `probeTimeoutMs = 3500`. */
export const defaultSyncServerStatusConfig: SyncServerStatusConfig = {
  probeTimeout: "3500 millis",
};

export interface SyncServerStatusService {
  /** Current status per enabled server URL. */
  readonly statuses: Effect.Effect<ReadonlyMap<string, SyncServerStatus>>;
  /** Status map stream: replays the current value, then every change. */
  readonly statusChanges: Stream.Stream<ReadonlyMap<string, SyncServerStatus>>;
  /**
   * Probes every enabled server once (in parallel) and updates the map.
   * Serialized — concurrent calls queue up. Never fails.
   */
  readonly refresh: Effect.Effect<void>;
}

export class SyncServerStatusStore extends Context.Tag("@linky/core/SyncServerStatusStore")<
  SyncServerStatusStore,
  SyncServerStatusService
>() {}

/**
 * Overall status across servers: `connected` when at least one server is
 * connected (one reachable server syncs the data), `checking` while none is
 * connected but probes are still running, `disconnected` otherwise —
 * including the no-active-servers case (sync is effectively off).
 */
export const overallSyncServerStatus = (
  statuses: ReadonlyMap<string, SyncServerStatus>,
): SyncServerStatus => {
  let checking = false;
  for (const status of statuses.values()) {
    if (status === "connected") return "connected";
    if (status === "checking") checking = true;
  }
  return checking ? "checking" : "disconnected";
};

const makeSyncServerStatusStore = (
  config: SyncServerStatusConfig,
): Effect.Effect<
  SyncServerStatusService,
  never,
  Scope.Scope | NostrTransport | SyncServerSettingsStore
> =>
  Effect.gen(function* () {
    const transport = yield* NostrTransport;
    const settingsStore = yield* SyncServerSettingsStore;
    const lock = yield* Effect.makeSemaphore(1);

    const ref = yield* SubscriptionRef.make<ReadonlyMap<string, SyncServerStatus>>(new Map());

    /** Open-and-close reachability check; `true` iff the socket opened in time. */
    const probe = (url: string): Effect.Effect<boolean> =>
      Effect.scoped(transport.connect(url)).pipe(
        Effect.timeoutFail({
          duration: config.probeTimeout,
          onTimeout: () => "timeout" as const,
        }),
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );

    /** Keep only `active` URLs; new ones enter as "checking". */
    const reconcile = (active: ReadonlyArray<string>) =>
      SubscriptionRef.update(ref, (current) => {
        const next = new Map<string, SyncServerStatus>();
        for (const url of active) next.set(url, current.get(url) ?? "checking");
        return next;
      });

    const refresh = lock.withPermits(1)(
      Effect.gen(function* () {
        const settings = yield* settingsStore.settings;
        const active = activeSyncServerUrls(settings);
        yield* reconcile(active);
        if (active.length === 0) return;
        const results = yield* Effect.forEach(
          active,
          (url) => probe(url).pipe(Effect.map((ok) => [url, ok] as const)),
          { concurrency: "unbounded" },
        );
        // Edits during the probe may have dropped entries; only update
        // servers that are still present.
        yield* SubscriptionRef.update(ref, (current) => {
          const next = new Map(current);
          for (const [url, ok] of results) {
            if (next.has(url)) next.set(url, ok ? "connected" : "disconnected");
          }
          return next;
        });
      }),
    );

    // Seed the map from the current settings, then track edits in a scoped
    // fiber so the map never shows removed/disabled servers and immediately
    // lists new ones as "checking".
    yield* settingsStore.settings.pipe(
      Effect.flatMap((settings) => reconcile(activeSyncServerUrls(settings))),
    );
    yield* Stream.runForEach(settingsStore.changes, (settings) =>
      reconcile(activeSyncServerUrls(settings)),
    ).pipe(Effect.forkScoped);

    return {
      statuses: SubscriptionRef.get(ref),
      statusChanges: ref.changes,
      refresh,
    };
  });

/**
 * Production Layer. Needs `NostrTransport` (WebSocket connect) and the
 * settings store. The settings-tracking fiber lives as long as the Layer's
 * scope.
 */
export const layerSyncServerStatusStore = (
  config: Partial<SyncServerStatusConfig> = {},
): Layer.Layer<SyncServerStatusStore, never, NostrTransport | SyncServerSettingsStore> =>
  Layer.scoped(
    SyncServerStatusStore,
    makeSyncServerStatusStore({ ...defaultSyncServerStatusConfig, ...config }),
  );
