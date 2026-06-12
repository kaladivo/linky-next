/**
 * SyncServerSettingsStore — the user-editable Evolu sync-server list (#53;
 * `sync.servers` + `settings.sync-servers` in the feature map).
 *
 * ## Semantics (PoC parity, `useEvoluServersManager` in the PoC)
 *
 * - URLs are normalized (trimmed, trailing slashes stripped) and compared
 *   case-insensitively; adding an already-listed URL is a no-op; order is
 *   preserved (defaults first, user additions appended).
 * - **Minimum-one rule** — removing the last server fails with
 *   `LastSyncServerError` (the PoC refused to remove the last server too:
 *   "Default server cannot be removed"). DISABLING every server is allowed,
 *   exactly like the PoC's per-server "Go offline": an all-disabled list
 *   makes the next store boot local-only (`transports: []`), while the list
 *   itself never goes empty.
 * - Defaults come from the environment config (`evoluSyncUrls`, per-profile
 *   endpoints from #4) — the feature works without any configuration.
 * - Validation: a sync server URL must be `wss://` (or `ws://` for local
 *   dev), same shape check as the relay settings.
 *
 * ## Persistence (PoC divergence, documented)
 *
 * The PoC persisted user EXTRAS plus an all-or-nothing "defaults removed"
 * flag — removing ONE default while keeping the other resurrected both on
 * reload. The rewrite persists the FULL configured list under
 * `linky.sync.serverUrls.v1` (mirroring `relaySettings.ts`,
 * `linky.nostr.relayUrls.v1`): per-URL removal of a default sticks. The
 * disabled set lives under its own key (`linky.sync.disabledServerUrls.v1`,
 * PoC: `linky.evoluServers.disabled.v1`). Unset / undecodable storage falls
 * back to the environment defaults; the keys are only written on user
 * edits, so a build that ships new defaults reaches users who never edited
 * the list.
 *
 * ## Applying the list to Evolu (restart-required, PoC parity)
 *
 * Unlike the relay list (RelayPool reconciles live), Evolu 7.4.1 fixes its
 * transports at `createEvolu` time and caches instances per database name —
 * there is no API to swap the config transports of a live instance, and
 * instances cannot be disposed. Edits therefore take effect on the NEXT
 * store boot (`storeManager` reads the active list when it creates the
 * store); the UI shows a restart-required hint after edits, exactly like
 * the PoC's "Evolu needs a reload to start syncing via the updated server
 * list" + reload button.
 */
import type { Stream } from "effect";
import { Context, Data, Effect, Layer, Option, Schema, SubscriptionRef } from "effect";

import { KeyValueStorage } from "../../ports/KeyValueStorage.js";
import { CurrentEnvironment } from "../environment/CurrentEnvironment.js";

/** KeyValueStorage key holding the configured sync-server list (JSON string array). */
export const SYNC_SERVER_SETTINGS_STORAGE_KEY = "linky.sync.serverUrls.v1";

/** KeyValueStorage key holding the disabled subset (JSON string array). */
export const SYNC_SERVER_DISABLED_STORAGE_KEY = "linky.sync.disabledServerUrls.v1";

/** One configured sync server; `enabled: false` = kept but not synced to. */
export interface SyncServerEntry {
  readonly url: string;
  readonly enabled: boolean;
}

export interface SyncServerSettings {
  readonly servers: ReadonlyArray<SyncServerEntry>;
}

/** The URLs the NEXT Evolu store boot will sync through (enabled, in order). */
export const activeSyncServerUrls = (settings: SyncServerSettings): ReadonlyArray<string> =>
  settings.servers.filter((server) => server.enabled).map((server) => server.url);

/** Not a `wss://` / `ws://` URL (after normalization). */
export class InvalidSyncServerUrlError extends Data.TaggedError("InvalidSyncServerUrlError")<{
  readonly url: string;
}> {}

/** Removing this server would leave the list empty (minimum-one rule). */
export class LastSyncServerError extends Data.TaggedError("LastSyncServerError")<{
  readonly url: string;
}> {}

/** KeyValueStorage write failed; the in-memory state was not changed. */
export class SyncServerSettingsStorageError extends Data.TaggedError(
  "SyncServerSettingsStorageError",
)<{
  readonly cause: unknown;
}> {}

/** `scheme://host` with a ws/wss scheme — same shape check as the env config. */
const SYNC_SERVER_URL_PATTERN = /^wss?:\/\/([a-z0-9.-]+|\[[0-9a-f:]+\])(?::\d+)?(?:[/?#]|$)/i;

/**
 * Trims and strips trailing slashes; returns `null` unless the result is a
 * `ws(s)://` URL. (The PoC additionally dropped query/hash via WHATWG URL;
 * core has no URL global, and nothing produces such inputs here.)
 */
export const normalizeSyncServerUrl = (raw: string): string | null => {
  const url = raw.trim().replace(/\/+$/, "");
  return SYNC_SERVER_URL_PATTERN.test(url) ? url : null;
};

/** Case-insensitive URL identity, like the PoC's lowercase comparisons. */
const sameSyncServerUrl = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

export interface SyncServerSettingsService {
  /** The current sync-server settings. */
  readonly settings: Effect.Effect<SyncServerSettings>;
  /** Replays the current settings, then every change. */
  readonly changes: Stream.Stream<SyncServerSettings>;
  /**
   * Adds a server URL (normalized, enabled). No-op when already listed.
   * Persists before resolving with the new settings.
   */
  readonly addServer: (
    url: string,
  ) => Effect.Effect<SyncServerSettings, InvalidSyncServerUrlError | SyncServerSettingsStorageError>;
  /**
   * Removes a server URL. No-op when not listed; fails with
   * `LastSyncServerError` when it is the only one left.
   */
  readonly removeServer: (
    url: string,
  ) => Effect.Effect<SyncServerSettings, LastSyncServerError | SyncServerSettingsStorageError>;
  /**
   * Enables/disables a listed server without removing it (the PoC's "Go
   * offline"). No-op when not listed. Disabling every server is allowed.
   */
  readonly setServerEnabled: (
    url: string,
    enabled: boolean,
  ) => Effect.Effect<SyncServerSettings, SyncServerSettingsStorageError>;
}

export class SyncServerSettingsStore extends Context.Tag("@linky/core/SyncServerSettingsStore")<
  SyncServerSettingsStore,
  SyncServerSettingsService
>() {}

const StoredUrls = Schema.parseJson(Schema.Array(Schema.String));
const decodeStoredUrls = Schema.decodeUnknownOption(StoredUrls);
const encodeStoredUrls = Schema.encodeSync(StoredUrls);

/** Normalizes, drops invalid entries, dedupes case-insensitively (in order). */
const sanitizeUrlList = (urls: ReadonlyArray<string>): ReadonlyArray<string> => {
  const seen = new Set<string>();
  const out: Array<string> = [];
  for (const raw of urls) {
    const url = normalizeSyncServerUrl(raw);
    if (url === null) continue;
    const key = url.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(url);
  }
  return out;
};

/**
 * Builds the service: loads the persisted list (falling back to the
 * environment defaults) and serializes edits. Exposed for tests; production
 * uses {@link layerSyncServerSettingsStore}.
 */
export const makeSyncServerSettingsStore: Effect.Effect<
  SyncServerSettingsService,
  never,
  KeyValueStorage.KeyValueStore | CurrentEnvironment
> = Effect.gen(function* () {
  const kv = yield* KeyValueStorage.KeyValueStore;
  const environment = yield* CurrentEnvironment;
  const lock = yield* Effect.makeSemaphore(1);

  // Storage read failure or undecodable content → defaults / empty set. The
  // keys are rewritten on the next edit, so corruption never sticks.
  const readKey = (key: string): Effect.Effect<ReadonlyArray<string>> =>
    kv.get(key).pipe(
      Effect.orElseSucceed(() => Option.none<string>()),
      Effect.map((stored) =>
        stored.pipe(
          Option.flatMap(decodeStoredUrls),
          Option.map(sanitizeUrlList),
          Option.getOrElse((): ReadonlyArray<string> => []),
        ),
      ),
    );

  const persistedUrls = yield* readKey(SYNC_SERVER_SETTINGS_STORAGE_KEY);
  const persistedDisabled = yield* readKey(SYNC_SERVER_DISABLED_STORAGE_KEY);

  const urls =
    persistedUrls.length > 0 ? persistedUrls : sanitizeUrlList(environment.evoluSyncUrls);
  const disabled = new Set(persistedDisabled.map((url) => url.toLowerCase()));

  const ref = yield* SubscriptionRef.make<SyncServerSettings>({
    servers: urls.map((url) => ({ url, enabled: !disabled.has(url.toLowerCase()) })),
  });

  /** Persist both keys + publish to subscribers, atomically. */
  const commit = (servers: ReadonlyArray<SyncServerEntry>) =>
    Effect.gen(function* () {
      const setKey = (key: string, value: ReadonlyArray<string>) =>
        kv
          .set(key, encodeStoredUrls(value))
          .pipe(Effect.mapError((cause) => new SyncServerSettingsStorageError({ cause })));
      yield* setKey(
        SYNC_SERVER_SETTINGS_STORAGE_KEY,
        servers.map((server) => server.url),
      );
      yield* setKey(
        SYNC_SERVER_DISABLED_STORAGE_KEY,
        servers.filter((server) => !server.enabled).map((server) => server.url),
      );
      const settings: SyncServerSettings = { servers };
      yield* SubscriptionRef.set(ref, settings);
      return settings;
    });

  return {
    settings: SubscriptionRef.get(ref),
    changes: ref.changes,

    addServer: (rawUrl) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const url = normalizeSyncServerUrl(rawUrl);
          if (url === null) {
            return yield* new InvalidSyncServerUrlError({ url: rawUrl });
          }
          const current = yield* SubscriptionRef.get(ref);
          if (current.servers.some((server) => sameSyncServerUrl(server.url, url))) {
            return current;
          }
          return yield* commit([...current.servers, { url, enabled: true }]);
        }),
      ),

    removeServer: (rawUrl) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const url = rawUrl.trim();
          const current = yield* SubscriptionRef.get(ref);
          if (!current.servers.some((server) => sameSyncServerUrl(server.url, url))) {
            return current;
          }
          const next = current.servers.filter((server) => !sameSyncServerUrl(server.url, url));
          if (next.length === 0) {
            return yield* new LastSyncServerError({ url });
          }
          return yield* commit(next);
        }),
      ),

    setServerEnabled: (rawUrl, enabled) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const url = rawUrl.trim();
          const current = yield* SubscriptionRef.get(ref);
          if (!current.servers.some((server) => sameSyncServerUrl(server.url, url))) {
            return current;
          }
          const next = current.servers.map((server) =>
            sameSyncServerUrl(server.url, url) ? { url: server.url, enabled } : server,
          );
          return yield* commit(next);
        }),
      ),
  };
});

/**
 * Production Layer. Loading never fails (bad storage → environment
 * defaults); edit-time storage failures surface on the edit calls.
 */
export const layerSyncServerSettingsStore: Layer.Layer<
  SyncServerSettingsStore,
  never,
  KeyValueStorage.KeyValueStore | CurrentEnvironment
> = Layer.effect(SyncServerSettingsStore, makeSyncServerSettingsStore);
