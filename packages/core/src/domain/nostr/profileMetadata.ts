/**
 * Profile metadata — Nostr kind 0 fetch, parse, and publish
 * (`nostr.fetch-profile`, `nostr.publish-profile`, `profile.publish-metadata`
 * in the feature map; issue #24).
 *
 * ## Event shape (PoC parity)
 *
 * The PoC (`nostrPublish.publishKind0ProfileMetadata` with the content built
 * by `useProfileAuthDomain.publishNewProfileMetadata`) publishes kind 0 with
 * empty tags and `content = JSON.stringify(record)` where the record carries,
 * in this key order and with empty fields omitted:
 *
 * - `name` and `display_name` (the chosen profile name),
 * - `lud16` (the Lightning address),
 * - `picture` and `image` (the avatar URL, both keys set to the same value).
 *
 * Pinned against the PoC's nostr-tools by
 * `__fixtures__/profileMetadata.golden.json`. Kind 0 is a replaceable event
 * (relays keep the newest `created_at` per author), so saving the profile
 * simply re-publishes; `created_at` comes from Effect's `Clock` (unix
 * seconds, floor — PoC parity).
 *
 * ## Fetching (contacts' profiles)
 *
 * `fetchProfileMetadata` is cache-first over the `KeyValueStorage` port
 * (positive results for 12 h, negative for 2 min — PoC TTLs, see
 * `protocolCache.ts`); on a miss it asks the pool for the author's kind-0
 * events and keeps the NEWEST by `created_at`, collecting relay responses
 * for a fixed query window (the pool has no end-of-stored-events signal;
 * the window mirrors the PoC's `querySync` `maxWait`). Parsing tolerates
 * malformed content (bad JSON / non-record / no useful fields → absent, PoC
 * behavior: the newest event wins even if unparseable). The fetch never
 * fails: offline or unknown authors resolve to `Option.none()`.
 *
 * ## Delivery
 *
 * Publishing uses the standard accepted-or-queued step (`deliverNostrEvent`):
 * per-relay retry via the pool, offline falls back to `NostrPendingQueue`.
 */
import type { Duration } from "effect";
import { Clock, Effect, Option, Schema, Stream } from "effect";

import type { ProfileMetadata } from "../../ports/ProfilePublisher.js";
import type { Randomness, RandomnessError } from "../../ports/Randomness.js";
import type { KeyValueStorage } from "../../ports/KeyValueStorage.js";
import type { ActiveNostrIdentity } from "../identity/customNostrKey.js";
import type { NostrEventDelivery } from "./deliver.js";
import { deliverNostrEvent } from "./deliver.js";
import type { NostrFilter } from "./filter.js";
import type { NostrEvent, NostrEventTemplate } from "./NostrEvent.js";
import { signNostrEvent } from "./NostrEvent.js";
import type { NostrPendingQueue, NostrPendingQueueError } from "./NostrPendingQueue.js";
import { RelayPool } from "./RelayPool.js";
import { makeProtocolCache } from "./protocolCache.js";

/** Kind 0 — NIP-01 profile metadata. Replaceable. */
export const PROFILE_METADATA_KIND = 0;

/** KV key prefix for the metadata cache (`<prefix><pubkeyHex>`). */
export const PROFILE_METADATA_CACHE_KEY_PREFIX = "linky.nostr.profileMetadata.v1:";

/** Positive cache TTL — the PoC's 12 h profile refresh window. */
export const PROFILE_METADATA_POSITIVE_TTL: Duration.DurationInput = "12 hours";
/** Negative cache TTL — short on purpose; relays can be slow/unreliable (PoC). */
export const PROFILE_METADATA_NEGATIVE_TTL: Duration.DurationInput = "2 minutes";

/** Collection window for a fetch — the PoC's `querySync` `maxWait`. */
export const DEFAULT_PROFILE_QUERY_WINDOW: Duration.DurationInput = "8 seconds";

/**
 * Parsed kind-0 metadata — exactly the fields the PoC reads
 * (`nostrProfile.NostrProfileMetadata`). All fields are trimmed non-empty
 * strings; absent means the event did not carry a useful value.
 */
export const NostrProfileMetadataSchema = Schema.Struct({
  name: Schema.optional(Schema.String),
  displayName: Schema.optional(Schema.String),
  picture: Schema.optional(Schema.String),
  image: Schema.optional(Schema.String),
  lud16: Schema.optional(Schema.String),
  lud06: Schema.optional(Schema.String),
});
export type NostrProfileMetadata = typeof NostrProfileMetadataSchema.Type;

// ---------------------------------------------------------------------------
// Parsing (PoC parity: nostrProfile.fetchNostrProfileMetadata)
// ---------------------------------------------------------------------------

const trimmedNonEmpty = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
};

/**
 * Parses a kind-0 `content` string. Malformed JSON, non-record values, and
 * records without any useful field all return `null` (so callers can cache
 * the negative result) — never a throw.
 */
export const parseProfileMetadataContent = (content: string): NostrProfileMetadata | null => {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;

  const name = trimmedNonEmpty(record["name"]);
  // PoC reads `display_name` with a `displayName` fallback.
  const displayName =
    trimmedNonEmpty(record["display_name"]) ?? trimmedNonEmpty(record["displayName"]);
  const lud16 = trimmedNonEmpty(record["lud16"]);
  const lud06 = trimmedNonEmpty(record["lud06"]);
  const picture = trimmedNonEmpty(record["picture"]);
  const image = trimmedNonEmpty(record["image"]);

  const metadata: NostrProfileMetadata = {
    ...(name !== undefined ? { name } : {}),
    ...(displayName !== undefined ? { displayName } : {}),
    ...(lud16 !== undefined ? { lud16 } : {}),
    ...(lud06 !== undefined ? { lud06 } : {}),
    ...(picture !== undefined ? { picture } : {}),
    ...(image !== undefined ? { image } : {}),
  };
  return Object.keys(metadata).length === 0 ? null : metadata;
};

// No `URL` global in core's build lib (no DOM/Node libs); these regexes
// encode the same checks the PoC performs with `new URL(...)`.
const HTTP_URL_PATTERN = /^https?:\/\/\S+$/i;
const DATA_IMAGE_URL_PATTERN = /^data:image\/(?:jpeg|jpg|png|webp|gif);base64,/i;

const isHttpUrl = (value: string): boolean => HTTP_URL_PATTERN.test(value);

const isDataImageUrl = (value: string): boolean => DATA_IMAGE_URL_PATTERN.test(value);

/** A URL the app may render as an avatar: http(s) or a base64 image data URL (PoC). */
export const isDisplayableProfilePictureUrl = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (trimmed === "") return false;
  return isHttpUrl(trimmed) || isDataImageUrl(trimmed);
};

/** The displayable avatar URL of a metadata record: `picture`, else `image` (PoC). */
export const profilePictureUrl = (
  metadata: NostrProfileMetadata | null | undefined,
): string | null => {
  const picture = metadata?.picture;
  if (isDisplayableProfilePictureUrl(picture)) return picture.trim();
  const image = metadata?.image;
  if (isDisplayableProfilePictureUrl(image)) return image.trim();
  return null;
};

// ---------------------------------------------------------------------------
// Publishing own metadata
// ---------------------------------------------------------------------------

/**
 * The kind-0 `content` for own profile metadata — PoC key order
 * (`name`, `display_name`, `lud16`, `picture`, `image`), values trimmed,
 * empties omitted, `picture`/`image` both set to the avatar URL. The exact
 * string is pinned by the golden fixture (key order is part of the event id).
 */
export const ownProfileMetadataContent = (metadata: ProfileMetadata): string => {
  const name = metadata.name.trim();
  const displayName = metadata.displayName.trim();
  const lud16 = metadata.lightningAddress?.trim() ?? "";
  const picture = metadata.pictureUrl?.trim() ?? "";
  const content: Record<string, string> = {
    ...(name !== "" ? { name } : {}),
    ...(displayName !== "" ? { display_name: displayName } : {}),
    ...(lud16 !== "" ? { lud16 } : {}),
    ...(picture !== "" ? { picture, image: picture } : {}),
  };
  return JSON.stringify(content);
};

/** The unsigned kind-0 template. Pure; exported for tests and previews. */
export const profileMetadataTemplate = (
  metadata: ProfileMetadata,
  createdAtSec: number,
): NostrEventTemplate => ({
  kind: PROFILE_METADATA_KIND,
  created_at: createdAtSec,
  tags: [],
  content: ownProfileMetadataContent(metadata),
});

/**
 * Signs and publishes own profile metadata as the active Nostr identity
 * (#20 — pass `IdentitySession.activeNostr`). Idempotent: kind 0 is
 * replaceable, every profile save just re-publishes. Never fails on a dead
 * network — that path resolves with `outcome: "queued"`.
 */
export const publishProfileMetadata = (
  identity: ActiveNostrIdentity,
  metadata: ProfileMetadata,
): Effect.Effect<
  NostrEventDelivery,
  RandomnessError | NostrPendingQueueError,
  Randomness | RelayPool | NostrPendingQueue
> =>
  Effect.gen(function* () {
    const millis = yield* Clock.currentTimeMillis;
    const template = profileMetadataTemplate(metadata, Math.floor(millis / 1000));
    const event = yield* signNostrEvent(template, identity.identity.secretKey);
    return yield* deliverNostrEvent(event);
  });

// ---------------------------------------------------------------------------
// Fetching a contact's metadata
// ---------------------------------------------------------------------------

const metadataCache = makeProtocolCache({
  keyPrefix: PROFILE_METADATA_CACHE_KEY_PREFIX,
  valueSchema: NostrProfileMetadataSchema,
  positiveTtl: PROFILE_METADATA_POSITIVE_TTL,
  negativeTtl: PROFILE_METADATA_NEGATIVE_TTL,
});

export interface FetchProfileOptions {
  /**
   * NIP-01 `since` (unix seconds) — used when fetching the OWN profile under
   * a custom key to ignore pre-switch events (`activatedAtSec`, PoC parity).
   */
  readonly sinceSec?: number;
  /** Override the relay collection window (tests use TestClock). */
  readonly queryWindow?: Duration.DurationInput;
}

/** Keeps the newest event by `created_at`; first received wins ties (PoC stable sort). */
const newerOf = (current: NostrEvent | null, candidate: NostrEvent): NostrEvent =>
  current === null || candidate.created_at > current.created_at ? candidate : current;

/**
 * A contact's kind-0 metadata, cache-first. `Option.none()` means "nothing
 * known": no event found, malformed newest event, or offline with no fresh
 * cache. The result (including the negative) is cached; the workflow never
 * fails.
 */
export const fetchProfileMetadata = (
  pubkeyHex: string,
  options: FetchProfileOptions = {},
): Effect.Effect<
  Option.Option<NostrProfileMetadata>,
  never,
  RelayPool | KeyValueStorage.KeyValueStore
> =>
  Effect.gen(function* () {
    const cached = yield* metadataCache.read(pubkeyHex);
    if (Option.isSome(cached)) return Option.fromNullable(cached.value);

    const pool = yield* RelayPool;
    const filter: NostrFilter = {
      kinds: [PROFILE_METADATA_KIND],
      authors: [pubkeyHex],
      limit: 5,
      ...(options.sinceSec !== undefined && options.sinceSec > 0
        ? { since: options.sinceSec }
        : {}),
    };
    const newest = yield* pool.subscribe([filter]).pipe(
      // Defense in depth: a relay could send events outside the filter.
      Stream.filter((event) => event.kind === PROFILE_METADATA_KIND && event.pubkey === pubkeyHex),
      Stream.interruptAfter(options.queryWindow ?? DEFAULT_PROFILE_QUERY_WINDOW),
      Stream.runFold(null as NostrEvent | null, newerOf),
    );

    const metadata = newest === null ? null : parseProfileMetadataContent(newest.content);
    yield* metadataCache.write(pubkeyHex, metadata);
    return Option.fromNullable(metadata);
  });

/** The contact's displayable avatar URL, via {@link fetchProfileMetadata}. */
export const fetchProfilePictureUrl = (
  pubkeyHex: string,
  options: FetchProfileOptions = {},
): Effect.Effect<Option.Option<string>, never, RelayPool | KeyValueStorage.KeyValueStore> =>
  Effect.map(fetchProfileMetadata(pubkeyHex, options), (metadata) =>
    Option.flatMap(metadata, (value) => Option.fromNullable(profilePictureUrl(value))),
  );
