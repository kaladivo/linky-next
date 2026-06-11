/**
 * Relay list publishing — NIP-65 relay metadata (kind 10002) and NIP-17
 * inbox relays (kind 10050), `nostr.publish-relay-lists` in the feature map
 * (issue #23). Deliverability depends on these: other clients look up the
 * kind 10002 list to know where to reach the user, and NIP-17 senders look
 * up the kind 10050 list to know where to drop gift wraps.
 *
 * ## Event shapes (PoC parity)
 *
 * The PoC (`useRelayDomain.publishNostrRelayLists`) publishes BOTH kinds
 * from one relay set:
 *
 * - kind 10002 — one `["r", url]` tag per relay, `content: ""`. No
 *   read/write markers: per NIP-65 an unmarked `r` tag means the relay is
 *   used for both read and write, which is exactly the PoC's semantics
 *   (a single relay set for everything).
 * - kind 10050 — one `["relay", url]` tag per relay, `content: ""`.
 *
 * URLs are trimmed, empties dropped, and deduplicated preserving first
 * occurrence (PoC behavior). The exact event structure is pinned against
 * the PoC's nostr-tools by `__fixtures__/relayLists.golden.json`.
 *
 * ## Replaceability and idempotence
 *
 * Both kinds are replaceable events (10000 <= kind < 20000, no `d` tag):
 * relays keep only the newest `created_at` per author+kind. Re-publishing
 * is therefore always safe — the standard triggers are relay-settings
 * changes and startup sync, both of which just call {@link publishRelayLists}
 * again. `created_at` comes from Effect's `Clock` (unix seconds, floor —
 * PoC parity with `Math.floor(Date.now() / 1000)`), so re-running within
 * the same second with the same settings even produces the identical event
 * id (a relay-side no-op).
 *
 * ## Relay settings source (#31 slot)
 *
 * The relay set is a PARAMETER ({@link RelaySettings}), not something this
 * module reads from a hardcoded source: today the only producer is the
 * environment config ({@link currentRelaySettings}); when #31 lands
 * user-editable relay settings, its service simply produces the
 * `RelaySettings` value instead and the workflows here are unchanged.
 *
 * ## Delivery (offline tolerance)
 *
 * Publishing goes through `RelayPool.publish` (per-relay retry with backoff
 * comes free). If NO relay accepts within the pool's retry policy — the
 * offline case — the signed event is enqueued to `NostrPendingQueue` and
 * goes out with the next flush (`runPendingFlushLoop` on reconnect).
 * Because the events are replaceable, flushing a stale queued list after a
 * newer one was published is harmless: relays keep the newest `created_at`.
 */
import { Clock, Effect } from "effect";

import type { Randomness, RandomnessError } from "../../ports/Randomness.js";
import { CurrentEnvironment } from "../environment/CurrentEnvironment.js";
import type { ActiveNostrIdentity } from "../identity/customNostrKey.js";
import type { NostrEventDelivery } from "./deliver.js";
import { deliverNostrEvent } from "./deliver.js";
import type { NostrEventTemplate } from "./NostrEvent.js";
import { signNostrEvent } from "./NostrEvent.js";
import type { NostrPendingQueueError } from "./NostrPendingQueue.js";
import type { NostrPendingQueue } from "./NostrPendingQueue.js";
import type { RelayPool } from "./RelayPool.js";

/** NIP-65 relay metadata. Replaceable. */
export const RELAY_LIST_KIND = 10002;
/** NIP-17 inbox relays (where the user receives gift wraps). Replaceable. */
export const INBOX_RELAY_LIST_KIND = 10050;

/**
 * The relay set to announce. Produced from the environment config today
 * ({@link currentRelaySettings}); #31's user-editable relay settings will
 * produce it instead — the publishing workflows take it as input and do not
 * care where it came from.
 */
export interface RelaySettings {
  readonly relayUrls: ReadonlyArray<string>;
}

/** The current `RelaySettings`: the configured relay set, until #31. */
export const currentRelaySettings: Effect.Effect<RelaySettings, never, CurrentEnvironment> =
  Effect.map(CurrentEnvironment, (environment) => ({
    relayUrls: environment.nostrRelayUrls,
  }));

/** Trim, drop empties, dedup preserving first occurrence (PoC behavior). */
export const normalizeRelayUrls = (urls: ReadonlyArray<string>): ReadonlyArray<string> => {
  const seen = new Set<string>();
  const out: Array<string> = [];
  for (const raw of urls) {
    const url = raw.trim();
    if (url === "" || seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
};

/**
 * The two unsigned templates for a relay set — kind 10002 with `r` tags,
 * kind 10050 with `relay` tags, both `content: ""` (PoC shape, pinned by
 * the golden fixture). Pure; exported for tests and for #31's preview UI.
 */
export const relayListTemplates = (
  relayUrls: ReadonlyArray<string>,
  createdAtSec: number,
): { readonly relayList: NostrEventTemplate; readonly inboxRelayList: NostrEventTemplate } => {
  const urls = normalizeRelayUrls(relayUrls);
  return {
    relayList: {
      kind: RELAY_LIST_KIND,
      created_at: createdAtSec,
      tags: urls.map((url) => ["r", url] as const),
      content: "",
    },
    inboxRelayList: {
      kind: INBOX_RELAY_LIST_KIND,
      created_at: createdAtSec,
      tags: urls.map((url) => ["relay", url] as const),
      content: "",
    },
  };
};

/** How one relay-list event left the device (see `deliver.ts`). */
export type RelayListDelivery = NostrEventDelivery;

export interface PublishRelayListsResult {
  /** The kind 10002 (NIP-65) event. */
  readonly relayList: RelayListDelivery;
  /** The kind 10050 (NIP-17 inbox) event. */
  readonly inboxRelayList: RelayListDelivery;
}

/**
 * Publishes the relay lists (kind 10002 + kind 10050) for the active Nostr
 * identity (#20 — the parameter type makes "custom key signs when active"
 * the caller's contract: pass `IdentitySession.activeNostr`).
 *
 * Idempotent — call it on every trigger (relay-settings change with the new
 * settings, startup sync via {@link publishCurrentRelayLists}); replaceable
 * events make re-publishing safe. Never fails on a dead network: that path
 * resolves with `outcome: "queued"`. The only failures are `RandomnessError`
 * (signing aux entropy) and `NostrPendingQueueError` (outbox storage).
 */
export const publishRelayLists = (
  identity: ActiveNostrIdentity,
  settings: RelaySettings,
): Effect.Effect<
  PublishRelayListsResult,
  RandomnessError | NostrPendingQueueError,
  Randomness | RelayPool | NostrPendingQueue
> =>
  Effect.gen(function* () {
    const millis = yield* Clock.currentTimeMillis;
    const createdAtSec = Math.floor(millis / 1000);
    const templates = relayListTemplates(settings.relayUrls, createdAtSec);
    const secretKey = identity.identity.secretKey;

    const relayListEvent = yield* signNostrEvent(templates.relayList, secretKey);
    const inboxRelayListEvent = yield* signNostrEvent(templates.inboxRelayList, secretKey);

    const [relayList, inboxRelayList] = yield* Effect.all(
      [deliverNostrEvent(relayListEvent), deliverNostrEvent(inboxRelayListEvent)],
      { concurrency: 2 },
    );
    return { relayList, inboxRelayList };
  });

/**
 * Startup-sync trigger: publishes the lists for the CURRENT relay settings
 * (environment config until #31). Same semantics as
 * {@link publishRelayLists}.
 */
export const publishCurrentRelayLists = (
  identity: ActiveNostrIdentity,
): Effect.Effect<
  PublishRelayListsResult,
  RandomnessError | NostrPendingQueueError,
  Randomness | RelayPool | NostrPendingQueue | CurrentEnvironment
> => Effect.flatMap(currentRelaySettings, (settings) => publishRelayLists(identity, settings));
