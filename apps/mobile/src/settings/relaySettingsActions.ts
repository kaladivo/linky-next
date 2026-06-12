/**
 * Actions + live view behind the relay settings screen (#31,
 * `nostr.relays` / `settings.relays`).
 *
 * Edits run the core `RelaySettingsStore` workflows (validation, min-one
 * rule, persistence, pool reconciliation) and map expected failures to
 * plain result values — the screen renders feedback, it never sees Effect
 * errors. After a successful edit the updated relay lists (kind 10002 +
 * 10050, #23) are republished fire-and-forget, exactly like the PoC's
 * `void publishNostrRelayLists(...).catch(log)`: the publish needs the
 * network, the list change must not wait for it (offline publishes are
 * queued by core's deliver step anyway).
 */
import type { RelayStatus } from "@linky/core";
import { RelayPool, RelaySettingsStore, loadSession, publishRelayLists } from "@linky/core";
import { Effect, Stream } from "effect";

import { runAppEffect } from "../runtime";

export type AddRelayResult = "added" | "invalid" | "failed";
export type RemoveRelayResult = "removed" | "last" | "failed";

/**
 * Republishes the relay lists for the active identity with the CURRENT
 * settings. Fire-and-forget; never rejects. No identity (pre-onboarding)
 * skips silently — there is nothing to sign with.
 */
const republishRelayLists = (): void => {
  void runAppEffect(
    Effect.gen(function* () {
      const state = yield* loadSession;
      if (state._tag === "NoIdentity") {
        yield* Effect.log("relay lists republish skipped: no identity");
        return;
      }
      const store = yield* RelaySettingsStore;
      const settings = yield* store.settings;
      const result = yield* publishRelayLists(state.session.activeNostr, settings);
      yield* Effect.log(
        `relay lists republished (${settings.relayUrls.length} relays): ` +
          `kind 10002 ${result.relayList.outcome}, kind 10050 ${result.inboxRelayList.outcome}`,
      );
    }).pipe(
      Effect.catchAll((error) =>
        Effect.logWarning(`relay lists republish failed: ${String(error)}`),
      ),
    ),
  ).catch((defect: unknown) => {
    console.warn("[relays] republish died:", defect);
  });
};

/** Adds a relay URL; on success triggers the relay-list republish. */
export const addRelay = async (url: string): Promise<AddRelayResult> => {
  const result = await runAppEffect(
    Effect.gen(function* () {
      const store = yield* RelaySettingsStore;
      yield* store.addRelay(url);
      return "added" as const;
    }).pipe(
      Effect.catchTag("InvalidRelayUrlError", () => Effect.succeed("invalid" as const)),
      Effect.catchTag("RelaySettingsStorageError", () => Effect.succeed("failed" as const)),
    ),
  );
  if (result === "added") republishRelayLists();
  return result;
};

/** Removes a relay URL; on success triggers the relay-list republish. */
export const removeRelay = async (url: string): Promise<RemoveRelayResult> => {
  const result = await runAppEffect(
    Effect.gen(function* () {
      const store = yield* RelaySettingsStore;
      yield* store.removeRelay(url);
      return "removed" as const;
    }).pipe(
      Effect.catchTag("LastRelayError", () => Effect.succeed("last" as const)),
      Effect.catchTag("RelaySettingsStorageError", () => Effect.succeed("failed" as const)),
    ),
  );
  if (result === "removed") republishRelayLists();
  return result;
};

/** Streams the relay list to `onChange`; runs until `signal` aborts. */
export const watchRelayUrls = (
  onChange: (urls: ReadonlyArray<string>) => void,
  signal: AbortSignal,
): void => {
  void runAppEffect(
    Effect.flatMap(RelaySettingsStore, (store) =>
      Stream.runForEach(store.changes, (settings) =>
        Effect.sync(() => onChange(settings.relayUrls)),
      ),
    ),
    { signal },
  ).catch(() => {
    // Interruption on unmount is the only expected rejection.
  });
};

/** Streams the per-relay status map to `onChange`; runs until `signal` aborts. */
export const watchRelayStatuses = (
  onChange: (statuses: ReadonlyMap<string, RelayStatus>) => void,
  signal: AbortSignal,
): void => {
  void runAppEffect(
    Effect.flatMap(RelayPool, (pool) =>
      Stream.runForEach(pool.statusChanges, (statuses) =>
        Effect.sync(() => onChange(new Map(statuses))),
      ),
    ),
    { signal },
  ).catch(() => {
    // Interruption on unmount is the only expected rejection.
  });
};
