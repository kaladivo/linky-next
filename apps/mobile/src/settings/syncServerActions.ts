/**
 * Actions + live view behind the sync-server settings screen (#53,
 * `sync.servers` / `sync.status` / `settings.sync-servers`).
 *
 * Edits run the core `SyncServerSettingsStore` workflows (validation,
 * min-one rule, persistence) and map expected failures to plain result
 * values — the screen renders feedback, it never sees Effect errors. Status
 * comes from core's `SyncServerStatusStore` probes; the screen drives
 * `refreshSyncServerStatuses` on an interval while visible (PoC: 15 s).
 *
 * Unlike relay edits, sync-server edits are NOT applied live: Evolu 7.4.1
 * fixes transports at store creation (see `storeManager`), so the screen
 * shows a restart hint and `restartAppForSyncServers` reloads the JS
 * bundle — a fresh context creates the store with the new list (the PoC's
 * "Reload now" button did the same with `window.location.reload()`).
 */
import type { SyncServerEntry, SyncServerStatus } from "@linky/core";
import { SyncServerSettingsStore, SyncServerStatusStore } from "@linky/core";
import { Effect, Stream } from "effect";
import { reloadAppAsync } from "expo";

import { runAppEffect } from "../runtime";

export type AddSyncServerResult = "added" | "invalid" | "failed";
export type RemoveSyncServerResult = "removed" | "last" | "failed";
export type ToggleSyncServerResult = "ok" | "failed";

/** Adds a sync server URL (takes effect after restart). */
export const addSyncServer = (url: string): Promise<AddSyncServerResult> =>
  runAppEffect(
    Effect.gen(function* () {
      const store = yield* SyncServerSettingsStore;
      yield* store.addServer(url);
      return "added" as const;
    }).pipe(
      Effect.catchTag("InvalidSyncServerUrlError", () => Effect.succeed("invalid" as const)),
      Effect.catchTag("SyncServerSettingsStorageError", () => Effect.succeed("failed" as const)),
    ),
  );

/** Removes a sync server URL; refuses to drop the last one (PoC rule). */
export const removeSyncServer = (url: string): Promise<RemoveSyncServerResult> =>
  runAppEffect(
    Effect.gen(function* () {
      const store = yield* SyncServerSettingsStore;
      yield* store.removeServer(url);
      return "removed" as const;
    }).pipe(
      Effect.catchTag("LastSyncServerError", () => Effect.succeed("last" as const)),
      Effect.catchTag("SyncServerSettingsStorageError", () => Effect.succeed("failed" as const)),
    ),
  );

/** Enables/disables a listed server without removing it (PoC "Go offline"). */
export const setSyncServerEnabled = (
  url: string,
  enabled: boolean,
): Promise<ToggleSyncServerResult> =>
  runAppEffect(
    Effect.gen(function* () {
      const store = yield* SyncServerSettingsStore;
      yield* store.setServerEnabled(url, enabled);
      return "ok" as const;
    }).pipe(
      Effect.catchTag("SyncServerSettingsStorageError", () => Effect.succeed("failed" as const)),
    ),
  );

/** Streams the configured server list to `onChange`; runs until `signal` aborts. */
export const watchSyncServers = (
  onChange: (servers: ReadonlyArray<SyncServerEntry>) => void,
  signal: AbortSignal,
): void => {
  void runAppEffect(
    Effect.flatMap(SyncServerSettingsStore, (store) =>
      Stream.runForEach(store.changes, (settings) =>
        Effect.sync(() => onChange(settings.servers)),
      ),
    ),
    { signal },
  ).catch(() => {
    // Interruption on unmount is the only expected rejection.
  });
};

/** Streams the per-server status map to `onChange`; runs until `signal` aborts. */
export const watchSyncServerStatuses = (
  onChange: (statuses: ReadonlyMap<string, SyncServerStatus>) => void,
  signal: AbortSignal,
): void => {
  void runAppEffect(
    Effect.flatMap(SyncServerStatusStore, (store) =>
      Stream.runForEach(store.statusChanges, (statuses) =>
        Effect.sync(() => onChange(new Map(statuses))),
      ),
    ),
    { signal },
  ).catch(() => {
    // Interruption on unmount is the only expected rejection.
  });
};

/** Probes every enabled server once. Never rejects (failures = disconnected). */
export const refreshSyncServerStatuses = (): Promise<void> =>
  runAppEffect(Effect.flatMap(SyncServerStatusStore, (store) => store.refresh)).catch(() => {
    // Probe failures are folded into statuses; only a dying runtime rejects.
  });

/**
 * Reloads the JS bundle so the next store boot picks up the edited server
 * list (Evolu cannot reconfigure live). Best-effort: when the reload API is
 * unavailable the user can still restart manually, as the hint says.
 */
export const restartAppForSyncServers = (): Promise<void> =>
  reloadAppAsync("sync servers changed (#53)").catch(() => {
    // Manual restart remains the fallback.
  });
