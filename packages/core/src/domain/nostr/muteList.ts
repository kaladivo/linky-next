/**
 * Mute list — Nostr kind 10000 blocked-sender publishing
 * (`nostr.block-pubkey` / `contacts.block` in the feature map, issue #28).
 *
 * ## Event shape (PoC parity)
 *
 * The PoC (`useAppShellComposition.blockPubkeyAndPublishMuteList`) publishes
 * kind **10000** with one `["p", pubkeyHex]` tag per blocked pubkey and
 * `content: ""` (no private/encrypted section). Pubkeys are normalized the
 * PoC way (`normalizePubkeyHex`): trimmed, lowercased, and they must be
 * exactly 64 hex chars — anything else is dropped. The exact event
 * structure is pinned against the PoC's nostr-tools by
 * `__fixtures__/muteList.golden.json`.
 *
 * ## Merge semantics (feature-map contract)
 *
 * "Publishing a block merges with the user's existing mute list instead of
 * replacing unrelated entries." Kind 10000 is replaceable (relays keep only
 * the newest event per author), so a naive publish would wipe entries made
 * by other clients. {@link publishMuteList} therefore:
 *
 * 1. fetches the author's current mute list from the relays
 *    ({@link fetchCurrentMuteList} — newest event wins, like every
 *    replaceable-kind read; offline/none → empty list),
 * 2. unions it with the locally blocked pubkeys (existing entries keep
 *    their relay-side order, new entries append in input order), and
 * 3. signs + publishes the merged list through the standard
 *    `deliverNostrEvent` path (accepted, or queued offline and flushed by
 *    `runPendingFlushLoop`).
 *
 * This is a superset of the PoC, which merged only with its own
 * locally-stored blocklist and silently replaced relay-side entries.
 *
 * Caller contract: pass the FULL local blocklist (not just the newly
 * blocked pubkey) so a queued/lost earlier publish is healed by the next
 * one. The local block always applies regardless of delivery outcome — the
 * caller must never gate local blocking on this workflow (PoC behavior).
 *
 * `created_at` comes from Effect's `Clock` in floored unix seconds — same
 * convention as `relayLists.ts`/`profileStatus.ts`. (The PoC used
 * `Math.ceil` here; the sub-second difference is irrelevant for a
 * replaceable event and floor keeps one convention across core.)
 */
import type { Duration } from "effect";
import { Clock, Effect, Stream } from "effect";

import type { Randomness, RandomnessError } from "../../ports/Randomness.js";
import type { ActiveNostrIdentity } from "../identity/customNostrKey.js";
import type { NostrEventDelivery } from "./deliver.js";
import { deliverNostrEvent } from "./deliver.js";
import type { NostrFilter } from "./filter.js";
import type { NostrEvent, NostrEventTemplate } from "./NostrEvent.js";
import { signNostrEvent } from "./NostrEvent.js";
import type { NostrPendingQueue, NostrPendingQueueError } from "./NostrPendingQueue.js";
import { RelayPool } from "./RelayPool.js";

/** NIP-51 mute list. Replaceable. */
export const MUTE_LIST_KIND = 10000;

/** Collection window for the current-list fetch (same as profile fetches). */
export const DEFAULT_MUTE_LIST_QUERY_WINDOW: Duration.DurationInput = "8 seconds";

const HEX_PUBKEY_RE = /^[a-f0-9]{64}$/;

/** PoC `normalizePubkeyHex`: trim + lowercase, exactly 64 hex chars or null. */
export const normalizePubkeyHex = (value: string): string | null => {
  const normalized = value.trim().toLowerCase();
  return HEX_PUBKEY_RE.test(normalized) ? normalized : null;
};

// npub → hex bridging for mute-list p-tags lives in ./npub.ts
// (npubToPublicKeyHex) — #27 and #28 converged on one implementation.

/** Normalizes + dedups, dropping invalid entries, first occurrence wins. */
export const normalizeMutedPubkeys = (
  values: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const seen = new Set<string>();
  const out: Array<string> = [];
  for (const raw of values) {
    const pubkey = normalizePubkeyHex(raw);
    if (pubkey === null || seen.has(pubkey)) continue;
    seen.add(pubkey);
    out.push(pubkey);
  }
  return out;
};

/** The muted pubkeys of a kind-10000 event: its `p` tags, normalized. */
export const mutedPubkeysOfEvent = (event: NostrEvent): ReadonlyArray<string> =>
  normalizeMutedPubkeys(
    event.tags.flatMap((tag) => (tag[0] === "p" && tag[1] !== undefined ? [tag[1]] : [])),
  );

/**
 * Union preserving order: existing (relay-side) entries first, then new
 * ones in input order. Pure; the merge contract's single source of truth.
 */
export const mergeMutedPubkeys = (
  existing: ReadonlyArray<string>,
  additions: ReadonlyArray<string>,
): ReadonlyArray<string> => normalizeMutedPubkeys([...existing, ...additions]);

/** Unsigned kind-10000 template (PoC shape, pinned by the golden fixture). */
export const muteListTemplate = (
  mutedPubkeys: ReadonlyArray<string>,
  createdAtSec: number,
): NostrEventTemplate => ({
  kind: MUTE_LIST_KIND,
  created_at: createdAtSec,
  tags: normalizeMutedPubkeys(mutedPubkeys).map((pubkey) => ["p", pubkey] as const),
  content: "",
});

export interface FetchMuteListOptions {
  /** Override the relay collection window (tests use TestClock). */
  readonly queryWindow?: Duration.DurationInput;
}

/** Keeps the newest event by `created_at`; first received wins ties. */
const newerOf = (current: NostrEvent | null, candidate: NostrEvent): NostrEvent =>
  current === null || candidate.created_at > current.created_at ? candidate : current;

/**
 * The author's current relay-side mute list: the newest kind-10000 event's
 * p-tags. Empty when no relay serves one within the window (none published,
 * or offline) — the merge then simply starts from the local list. Never
 * fails; no cache (a block must merge against the live list, not a stale
 * copy).
 */
export const fetchCurrentMuteList = (
  publicKeyHex: string,
  options: FetchMuteListOptions = {},
): Effect.Effect<ReadonlyArray<string>, never, RelayPool> =>
  Effect.gen(function* () {
    const pool = yield* RelayPool;
    const filter: NostrFilter = {
      kinds: [MUTE_LIST_KIND],
      authors: [publicKeyHex],
      limit: 5,
    };
    const newest = yield* pool.subscribe([filter]).pipe(
      // Defense in depth: a relay could send events outside the filter.
      Stream.filter((event) => event.kind === MUTE_LIST_KIND && event.pubkey === publicKeyHex),
      Stream.interruptAfter(options.queryWindow ?? DEFAULT_MUTE_LIST_QUERY_WINDOW),
      Stream.runFold(null as NostrEvent | null, newerOf),
    );
    return newest === null ? [] : mutedPubkeysOfEvent(newest);
  });

export interface PublishMuteListResult {
  /** How the merged kind-10000 event left the device (accepted/queued). */
  readonly delivery: NostrEventDelivery;
  /** The full published list: relay-side entries ∪ blocked pubkeys. */
  readonly mutedPubkeys: ReadonlyArray<string>;
  /** What the relays served before the merge (empty when none/offline). */
  readonly existingPubkeys: ReadonlyArray<string>;
}

/**
 * Publishes the mute list for the active Nostr identity with
 * `blockedPubkeys` merged into the existing relay-side entries (see module
 * docs for the full contract). Idempotent: re-publishing the same blocklist
 * yields the same merged list, and replaceability makes re-publishing safe.
 * Never fails on a dead network — that path resolves with the fetch coming
 * back empty and `delivery.outcome: "queued"`.
 */
export const publishMuteList = (
  identity: ActiveNostrIdentity,
  blockedPubkeys: ReadonlyArray<string>,
  options: FetchMuteListOptions = {},
): Effect.Effect<
  PublishMuteListResult,
  RandomnessError | NostrPendingQueueError,
  Randomness | RelayPool | NostrPendingQueue
> =>
  Effect.gen(function* () {
    const existingPubkeys = yield* fetchCurrentMuteList(identity.identity.publicKeyHex, options);
    const mutedPubkeys = mergeMutedPubkeys(existingPubkeys, blockedPubkeys);

    const millis = yield* Clock.currentTimeMillis;
    const template = muteListTemplate(mutedPubkeys, Math.floor(millis / 1000));
    const event = yield* signNostrEvent(template, identity.identity.secretKey);
    const delivery = yield* deliverNostrEvent(event);
    return { delivery, mutedPubkeys, existingPubkeys };
  });
