/**
 * Profile status — NIP-38 user status (kind 30315), `profile.publish-status`
 * in the feature map (issue #24).
 *
 * ## Event shape (PoC parity, `nostrStatus.ts`)
 *
 * One parameterized-replaceable event per author: kind 30315 with a single
 * `["d", "general"]` tag and the status string as `content` (`""` clears the
 * status). Pinned against the PoC's nostr-tools by
 * `__fixtures__/profileMetadata.golden.json`.
 *
 * ## Linky's status string encoding
 *
 * The Linky-specific payload inside the general status is a CURRENCY
 * PREFERENCE line — the currencies the user trades (`BTC`/`CZK`/`USD`),
 * consumed by the post-v1 contact filters (`status:<CUR>` filter values):
 *
 * ```text
 * <free-form status text>\n
 * BTC, CZK
 * ```
 *
 * `parseProfileGeneralStatus` ports the PoC's exact decoding: scan lines
 * BOTTOM-UP for the first line that is a strict comma-separated list of
 * unique, known currency codes (case-insensitive); that line carries the
 * currencies and everything ABOVE it is the free-form text. No such line →
 * the whole status is text. `buildProfileGeneralStatus` is the encoder dual
 * (canonical currency order, `", "` separator, joined to the text with a
 * newline).
 *
 * ## Fetching
 *
 * `fetchProfileGeneralStatus` mirrors the metadata fetch: cache-first
 * (positive 12 h / negative 2 min), then the newest non-expired
 * `d == "general"` event within the query window. NIP-40 `expiration` tags
 * are honored (expired statuses are skipped, PoC behavior). Never fails;
 * absence is `Option.none()`.
 */
import type { Duration } from "effect";
import { Clock, Effect, Option, Schema, Stream } from "effect";

import type { KeyValueStorage } from "../../ports/KeyValueStorage.js";
import type { Randomness, RandomnessError } from "../../ports/Randomness.js";
import type { ActiveNostrIdentity } from "../identity/customNostrKey.js";
import type { NostrEventDelivery } from "./deliver.js";
import { deliverNostrEvent } from "./deliver.js";
import type { NostrEvent, NostrEventTemplate } from "./NostrEvent.js";
import { signNostrEvent } from "./NostrEvent.js";
import type { NostrPendingQueue, NostrPendingQueueError } from "./NostrPendingQueue.js";
import { RelayPool } from "./RelayPool.js";
import { DEFAULT_PROFILE_QUERY_WINDOW } from "./profileMetadata.js";
import { makeProtocolCache } from "./protocolCache.js";

/** Kind 30315 — NIP-38 user status. Parameterized replaceable (`d` tag). */
export const PROFILE_STATUS_KIND = 30315;

/** The `d` tag identifier Linky uses (NIP-38 "general" status). */
export const GENERAL_STATUS_IDENTIFIER = "general";

/** KV key prefix for the status cache (`<prefix><pubkeyHex>`). */
export const PROFILE_STATUS_CACHE_KEY_PREFIX = "linky.nostr.profileStatus.v1:";

/** The currencies the Linky status encoding knows (PoC set, canonical order). */
export const PROFILE_STATUS_CURRENCIES = ["BTC", "CZK", "USD"] as const;
export type ProfileStatusCurrency = (typeof PROFILE_STATUS_CURRENCIES)[number];

/** A decoded general status: currency preferences + free-form text. */
export interface ProfileGeneralStatus {
  readonly currencies: ReadonlyArray<ProfileStatusCurrency>;
  readonly text: string | null;
}

// ---------------------------------------------------------------------------
// Status string codec (PoC parity: nostrStatus.ts)
// ---------------------------------------------------------------------------

/** Trim; empty becomes `null` (PoC `normalizeStatusText`). */
export const normalizeStatusText = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
};

const CURRENCY_CODE_PATTERN = /^[A-Z0-9]{2,10}$/;

/**
 * A line is a currency-codes line iff it is a comma-separated list of
 * UNIQUE, well-formed codes (uppercased before checking). Anything else —
 * duplicates, malformed parts — is ordinary text (PoC rules).
 */
const parseCurrencyStatusCodes = (status: string | null | undefined): Array<string> | null => {
  const normalized = normalizeStatusText(status);
  if (normalized === null) return null;

  const parts = normalized
    .split(",")
    .map((part) => part.trim().toUpperCase())
    .filter((part) => part !== "");
  if (parts.length === 0) return null;

  const uniqueParts = [...new Set(parts)];
  if (uniqueParts.length !== parts.length) return null;
  if (!uniqueParts.every((part) => CURRENCY_CODE_PATTERN.test(part))) return null;
  return uniqueParts;
};

/** The line must contain ONLY known currencies to count (PoC rules). */
const parseLinkyExchangeCurrencies = (
  status: string | null | undefined,
): Array<ProfileStatusCurrency> | null => {
  const parts = parseCurrencyStatusCodes(status);
  if (parts === null || parts.length === 0) return null;
  const known = new Set<string>(PROFILE_STATUS_CURRENCIES);
  if (!parts.every((part) => known.has(part))) return null;
  return parts.filter((part): part is ProfileStatusCurrency => known.has(part));
};

/**
 * Decodes a raw status string: scans lines bottom-up for the first
 * currency-codes line; that line is the currency preference, the lines
 * ABOVE it are the text. No currency line → the whole status is text.
 * (Exact PoC behavior, including dropping any lines below the currency
 * line.) Contract from the feature map: contact status filters depend on
 * this staying parseable.
 */
export const parseProfileGeneralStatus = (
  status: string | null | undefined,
): ProfileGeneralStatus => {
  const normalized = normalizeStatusText(status);
  if (normalized === null) return { currencies: [], text: null };

  const lines = normalized.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const currencies = parseLinkyExchangeCurrencies(lines[index]);
    if (currencies === null) continue;
    return { currencies, text: normalizeStatusText(lines.slice(0, index).join("\n")) };
  }
  return { currencies: [], text: normalized };
};

/**
 * Encodes a status string from text + currency preferences:
 * `"<text>\n<CUR1, CUR2>"`, either part omitted when empty, `null` when both
 * are. Currencies are emitted in canonical {@link PROFILE_STATUS_CURRENCIES}
 * order (PoC behavior).
 */
export const buildProfileGeneralStatus = (input: {
  readonly currencies: ReadonlyArray<ProfileStatusCurrency>;
  readonly text: string | null | undefined;
}): string | null => {
  const text = normalizeStatusText(input.text);
  const selected = PROFILE_STATUS_CURRENCIES.filter((currency) =>
    input.currencies.includes(currency),
  );
  if (text !== null && selected.length > 0) return `${text}\n${selected.join(", ")}`;
  if (text !== null) return text;
  return selected.length > 0 ? selected.join(", ") : null;
};

// ---------------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------------

/** The unsigned kind-30315 template; `null` status publishes `""` (clears). */
export const profileStatusTemplate = (
  status: string | null,
  createdAtSec: number,
): NostrEventTemplate => ({
  kind: PROFILE_STATUS_KIND,
  created_at: createdAtSec,
  tags: [["d", GENERAL_STATUS_IDENTIFIER]],
  content: normalizeStatusText(status) ?? "",
});

/**
 * Signs and publishes the general status as the active Nostr identity
 * (#20). Parameterized-replaceable, so every save just re-publishes;
 * `null` clears the status. Never fails on a dead network — that path
 * resolves with `outcome: "queued"`.
 */
export const publishProfileGeneralStatus = (
  identity: ActiveNostrIdentity,
  status: string | null,
): Effect.Effect<
  NostrEventDelivery,
  RandomnessError | NostrPendingQueueError,
  Randomness | RelayPool | NostrPendingQueue
> =>
  Effect.gen(function* () {
    const millis = yield* Clock.currentTimeMillis;
    const template = profileStatusTemplate(status, Math.floor(millis / 1000));
    const event = yield* signNostrEvent(template, identity.identity.secretKey);
    return yield* deliverNostrEvent(event);
  });

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

const statusCache = makeProtocolCache({
  keyPrefix: PROFILE_STATUS_CACHE_KEY_PREFIX,
  valueSchema: Schema.String,
  positiveTtl: "12 hours",
  negativeTtl: "2 minutes",
});

/** NIP-40 `expiration` tag (unix seconds); malformed/non-positive → none (PoC). */
const expirationSec = (event: NostrEvent): number | null => {
  for (const tag of event.tags) {
    if (tag[0] !== "expiration") continue;
    const expiration = Number(tag[1] ?? "");
    if (!Number.isFinite(expiration) || expiration <= 0) return null;
    return expiration;
  }
  return null;
};

const isExpiredAt = (event: NostrEvent, nowSec: number): boolean => {
  const expiration = expirationSec(event);
  return expiration !== null && expiration <= nowSec;
};

const hasGeneralIdentifier = (event: NostrEvent): boolean =>
  event.tags.some((tag) => tag[0] === "d" && tag[1] === GENERAL_STATUS_IDENTIFIER);

export interface FetchProfileStatusOptions {
  /** Override the relay collection window (tests use TestClock). */
  readonly queryWindow?: Duration.DurationInput;
}

/**
 * A contact's raw general-status string (decode with
 * {@link parseProfileGeneralStatus}), cache-first. The newest non-expired
 * `d == "general"` event wins; empty content normalizes to absent. Never
 * fails; the result (including the negative) is cached.
 */
export const fetchProfileGeneralStatus = (
  pubkeyHex: string,
  options: FetchProfileStatusOptions = {},
): Effect.Effect<Option.Option<string>, never, RelayPool | KeyValueStorage.KeyValueStore> =>
  Effect.gen(function* () {
    const cached = yield* statusCache.read(pubkeyHex);
    if (Option.isSome(cached)) return Option.fromNullable(cached.value);

    const pool = yield* RelayPool;
    const events = yield* pool
      .subscribe([{ kinds: [PROFILE_STATUS_KIND], authors: [pubkeyHex], limit: 20 }])
      .pipe(
        Stream.filter((event) => event.kind === PROFILE_STATUS_KIND && event.pubkey === pubkeyHex),
        Stream.interruptAfter(options.queryWindow ?? DEFAULT_PROFILE_QUERY_WINDOW),
        Stream.runCollect,
      );

    const nowSec = Math.floor((yield* Clock.currentTimeMillis) / 1000);
    const newest = [...events]
      .sort((a, b) => b.created_at - a.created_at)
      .find((event) => hasGeneralIdentifier(event) && !isExpiredAt(event, nowSec));

    const status = newest === undefined ? null : normalizeStatusText(newest.content);
    yield* statusCache.write(pubkeyHex, status);
    return Option.fromNullable(status);
  });
