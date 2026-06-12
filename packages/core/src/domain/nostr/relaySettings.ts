/**
 * RelaySettingsStore — the user-editable relay list (#31; `nostr.relays` +
 * `settings.relays` in the feature map). This is the producer of the
 * `RelaySettings` value that relay-list publishing (#23) takes as input,
 * and the single writer of the RelayPool's live relay set.
 *
 * ## Semantics (PoC parity, `useRelayDomain` in the PoC)
 *
 * - URLs are trimmed; adding an already-listed URL is a no-op; order is
 *   preserved (defaults first, user additions appended).
 * - **Minimum-one rule** — removing the last relay fails with
 *   `LastRelayError`; the UI surfaces it, the list never goes empty.
 * - Defaults come from the environment config (`nostrRelayUrls`), exactly
 *   like the PoC fell back to its built-in `NOSTR_RELAYS`.
 * - Validation: a relay URL must be `wss://` (or `ws://` for local dev) —
 *   the PoC accepted any non-empty string on save but silently ignored
 *   non-WebSocket URLs everywhere it used the list; rejecting them at the
 *   door keeps the same effective behavior without the dead entries.
 *
 * ## Persistence (decided here)
 *
 * The PoC persisted NOTHING locally: the relay list lived on the network
 * (kind 10002/10050, refetched on startup) with in-memory state per
 * session. The rewrite keeps the network as the cross-device channel
 * (publishing via #23) but also persists the list device-locally through
 * the `KeyValueStorage` port (key `linky.nostr.relayUrls.v1`, JSON string
 * array) so the pool reconnects to the user's relays immediately on cold
 * start, offline included. The port's own doc names "relay list overrides"
 * as its intended cargo. NOT Evolu: the relay list belongs to the Nostr
 * identity (it must hold even when Evolu sync is down — relay settings are
 * what make the user reachable), and core cannot depend on the store
 * anyway. Unset / undecodable storage falls back to the environment
 * defaults; the key is only written on user edits.
 *
 * ## Pool reconciliation
 *
 * The layer applies the loaded list to the `RelayPool` at construction and
 * after every edit (`RelayPool.setRelayUrls`), so per-relay connection
 * status on the settings screen covers exactly the listed relays.
 *
 * Publishing the updated lists (kind 10002/10050) is the caller's step —
 * `publishRelayLists(identity, settings)` — because signing needs the
 * active identity, which is session state core never holds in a Layer.
 */
import type { Stream } from "effect";
import { Context, Data, Effect, Layer, Option, Schema, SubscriptionRef } from "effect";

import { KeyValueStorage } from "../../ports/KeyValueStorage.js";
import { CurrentEnvironment } from "../environment/CurrentEnvironment.js";
import type { RelaySettings } from "./relayLists.js";
import { normalizeRelayUrls } from "./relayLists.js";
import { RelayPool } from "./RelayPool.js";

/** KeyValueStorage key holding the user-edited relay list (JSON string array). */
export const RELAY_SETTINGS_STORAGE_KEY = "linky.nostr.relayUrls.v1";

/** Not a `wss://` / `ws://` URL (after trimming). */
export class InvalidRelayUrlError extends Data.TaggedError("InvalidRelayUrlError")<{
  readonly url: string;
}> {}

/** Removing this relay would leave the list empty (minimum-one rule). */
export class LastRelayError extends Data.TaggedError("LastRelayError")<{
  readonly url: string;
}> {}

/** KeyValueStorage write failed; the in-memory/pool state was not changed. */
export class RelaySettingsStorageError extends Data.TaggedError("RelaySettingsStorageError")<{
  readonly cause: unknown;
}> {}

/** `scheme://host` with a ws/wss scheme — same shape check as the env config. */
const RELAY_URL_PATTERN = /^wss?:\/\/([a-z0-9.-]+|\[[0-9a-f:]+\])(?::\d+)?(?:[/?#]|$)/i;

export const isValidRelayUrl = (url: string): boolean => RELAY_URL_PATTERN.test(url);

export interface RelaySettingsStoreService {
  /** The current relay settings. */
  readonly settings: Effect.Effect<RelaySettings>;
  /** Replays the current settings, then every change. */
  readonly changes: Stream.Stream<RelaySettings>;
  /**
   * Adds a relay URL (trimmed). No-op when already listed. Persists and
   * reconciles the pool before resolving with the new settings.
   */
  readonly addRelay: (
    url: string,
  ) => Effect.Effect<RelaySettings, InvalidRelayUrlError | RelaySettingsStorageError>;
  /**
   * Removes a relay URL (trimmed). No-op when not listed; fails with
   * `LastRelayError` when it is the only one left.
   */
  readonly removeRelay: (
    url: string,
  ) => Effect.Effect<RelaySettings, LastRelayError | RelaySettingsStorageError>;
}

export class RelaySettingsStore extends Context.Tag("@linky/core/RelaySettingsStore")<
  RelaySettingsStore,
  RelaySettingsStoreService
>() {}

const StoredRelayUrls = Schema.parseJson(Schema.Array(Schema.String));
const decodeStoredRelayUrls = Schema.decodeUnknownOption(StoredRelayUrls);
const encodeStoredRelayUrls = Schema.encodeSync(StoredRelayUrls);

/**
 * Builds the service: loads the persisted list (falling back to the
 * environment defaults), applies it to the pool, and serializes edits.
 * Exposed for tests; production uses {@link layerRelaySettingsStore}.
 */
export const makeRelaySettingsStore: Effect.Effect<
  RelaySettingsStoreService,
  never,
  KeyValueStorage.KeyValueStore | CurrentEnvironment | RelayPool
> = Effect.gen(function* () {
  const kv = yield* KeyValueStorage.KeyValueStore;
  const environment = yield* CurrentEnvironment;
  const pool = yield* RelayPool;
  const lock = yield* Effect.makeSemaphore(1);

  const defaults = normalizeRelayUrls(environment.nostrRelayUrls);

  // Storage read failure or undecodable/empty content → defaults. The key
  // is rewritten on the next edit, so corruption never sticks.
  const stored = yield* kv
    .get(RELAY_SETTINGS_STORAGE_KEY)
    .pipe(Effect.orElseSucceed(() => Option.none<string>()));
  const persisted = stored.pipe(
    Option.flatMap(decodeStoredRelayUrls),
    Option.map((urls) => normalizeRelayUrls(urls).filter(isValidRelayUrl)),
    Option.getOrElse((): ReadonlyArray<string> => []),
  );
  const initial: RelaySettings = { relayUrls: persisted.length > 0 ? persisted : defaults };

  const ref = yield* SubscriptionRef.make<RelaySettings>(initial);
  yield* pool.setRelayUrls(initial.relayUrls);

  /** Persist + publish to subscribers + reconcile the pool, atomically. */
  const commit = (relayUrls: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      yield* kv
        .set(RELAY_SETTINGS_STORAGE_KEY, encodeStoredRelayUrls(relayUrls))
        .pipe(Effect.mapError((cause) => new RelaySettingsStorageError({ cause })));
      const settings: RelaySettings = { relayUrls };
      yield* SubscriptionRef.set(ref, settings);
      yield* pool.setRelayUrls(relayUrls);
      return settings;
    });

  return {
    settings: SubscriptionRef.get(ref),
    changes: ref.changes,

    addRelay: (rawUrl) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const url = rawUrl.trim();
          if (!isValidRelayUrl(url)) {
            return yield* new InvalidRelayUrlError({ url });
          }
          const current = yield* SubscriptionRef.get(ref);
          if (current.relayUrls.includes(url)) return current;
          return yield* commit([...current.relayUrls, url]);
        }),
      ),

    removeRelay: (rawUrl) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const url = rawUrl.trim();
          const current = yield* SubscriptionRef.get(ref);
          if (!current.relayUrls.includes(url)) return current;
          const next = current.relayUrls.filter((listed) => listed !== url);
          if (next.length === 0) {
            return yield* new LastRelayError({ url });
          }
          return yield* commit(next);
        }),
      ),
  };
});

/**
 * Production Layer. Loading never fails (bad storage → environment
 * defaults); edit-time storage failures surface on the edit calls.
 */
export const layerRelaySettingsStore: Layer.Layer<
  RelaySettingsStore,
  never,
  KeyValueStorage.KeyValueStore | CurrentEnvironment | RelayPool
> = Layer.effect(RelaySettingsStore, makeRelaySettingsStore);
