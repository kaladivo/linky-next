/**
 * Linky Evolu schema — the base tables for all six sync domains (issue #15).
 *
 * ## Domain map
 *
 * Every table belongs to exactly one sync domain (see `tableSyncDomain` in
 * `domains.ts`); all of a domain's rows are written to that domain's derived
 * owner lane (issue #13: master secret -> lane mnemonic -> Evolu owner).
 *
 * | Table            | Domain         | Rows                                  |
 * | ---------------- | -------------- | ------------------------------------- |
 * | `contact`        | `contacts`     | Address-book entries                  |
 * | `blockedSender`  | `contacts`     | Blocked sender npubs (survive sync)   |
 * | `cashuToken`     | `wallet`       | Cashu ecash tokens                    |
 * | `cashuMint`      | `wallet`       | Known mints + cached NUT-06 info      |
 * | `message`        | `messages`     | Decrypted NIP-17 chat messages        |
 * | `reaction`       | `messages`     | NIP-17 emoji reactions                |
 * | `transaction`    | `transactions` | Wallet history entries                |
 * | `nostrIdentity`  | `identity`     | Active/previous Nostr identities      |
 * | `metaEntry`      | `meta`         | Cross-device key/value coordination   |
 * | `_unknownThread` | local-only     | Inbound threads from unsaved senders  |
 * | `_cashuCounter`  | local-only     | NUT-13 counters + restore cursors     |
 *
 * `_unknownThread` is a **local-only** table: Evolu treats every table whose
 * name starts with `_` as device-local (verified in 7.4.1 — mutations on `_`
 * tables bypass the CRDT/sync pipeline entirely, never reach `evolu_history`,
 * and `isDeleted` physically deletes the row). That matches the feature map's
 * `contacts.unknown` contract: an unknown thread is a local safety boundary,
 * not synced data, so blocking/removing it on one device can never be undone
 * by sync. The thread's *messages* still live in the synced `message` table
 * (keyed by `peerNpub`), which is what makes `contacts.promote-unknown` and
 * `contacts.delete-to-unknown` pure metadata operations — no message rows
 * move between tables.
 *
 * Columns are informed by the PoC (`linky-poc/apps/web-app/src/evolu.ts`);
 * they grow with issue #35. Evolu schema evolution is additive, so extending
 * tables later is safe.
 *
 * ## Conversation identity (decided here, issue #25)
 *
 * Chat rows reference conversations by the peer's NIP-19 npub (`peerNpub`),
 * NOT by `contactId`. A conversation with a saved contact is the one whose
 * `contact.npub` equals the message's `peerNpub`; a conversation without a
 * matching contact is an unknown thread. Consequences:
 *
 * - Promoting an unknown sender to a contact, or deleting a contact back to
 *   an unknown thread, never rewrites message rows.
 * - Messages survive `chat.retention` (no caps) and contact churn alike.
 * - Dedup is by `rumorId` (the inner unsigned kind-14 event id), the key the
 *   NIP-17 engine (#22) hands to storage — enforced by `MessagesRepository`
 *   (Evolu has no unique constraints).
 *
 * ## Conventions (fixed now, relied on by every later issue)
 *
 * - **Ids**: Evolu branded ids via `id("PascalCaseName")`, one per table,
 *   exported as both value and type. Foreign keys reuse the referenced
 *   table's id type (`contactId: ContactId`).
 * - **Strings**: `NonEmptyString100` for short codes/enum-ish values,
 *   `NonEmptyString1000` for identifiers/labels/URLs, `NonEmptyString`
 *   (unbounded, mutation-size limited) for payloads (tokens, message bodies,
 *   JSON details).
 * - **Timestamps**: domain-event times are `*AtSec` columns (`PositiveInt`,
 *   unix seconds — e.g. when a Nostr event was created). Row audit times are
 *   Evolu's automatic system columns (`createdAt`, `updatedAt`); soft delete
 *   is the system `isDeleted` flag; lane assignment is the system `ownerId`
 *   column. Never declare system columns manually.
 * - **Optionality**: every column that is not strictly required at insert
 *   time is `nullOr(...)` — Evolu rows can sync partially, so readers must
 *   treat optional columns as nullable anyway.
 */
import {
  id,
  NonEmptyString,
  NonEmptyString100,
  NonEmptyString1000,
  nullOr,
  PositiveInt,
  union,
} from "@evolu/common";
import type { TokenState } from "@linky/core";

export const ContactId = id("Contact");
export type ContactId = typeof ContactId.Type;

export const CashuTokenId = id("CashuToken");
export type CashuTokenId = typeof CashuTokenId.Type;

export const CashuMintId = id("CashuMint");
export type CashuMintId = typeof CashuMintId.Type;

export const CashuCounterId = id("CashuCounter");
export type CashuCounterId = typeof CashuCounterId.Type;

export const MessageId = id("Message");
export type MessageId = typeof MessageId.Type;

export const TransactionId = id("Transaction");
export type TransactionId = typeof TransactionId.Type;

export const NostrIdentityId = id("NostrIdentity");
export type NostrIdentityId = typeof NostrIdentityId.Type;

export const MetaEntryId = id("MetaEntry");
export type MetaEntryId = typeof MetaEntryId.Type;

export const ReactionId = id("Reaction");
export type ReactionId = typeof ReactionId.Type;

export const BlockedSenderId = id("BlockedSender");
export type BlockedSenderId = typeof BlockedSenderId.Type;

export const UnknownThreadId = id("UnknownThread");
export type UnknownThreadId = typeof UnknownThreadId.Type;

/**
 * The eight token states of the #33 state model (`@linky/core`
 * `tokenState.ts`), enforced at the column level: Evolu validates every
 * `cashuToken.state` mutation against this union, so an out-of-model state
 * can never be persisted. The literal list is duplicated here (instead of
 * spreading core's `TOKEN_STATES`) to keep the schema module free of runtime
 * imports; the compile-time assertions below pin it to core's `TokenState`
 * in both directions.
 */
export const CashuTokenState = union(
  "accepted",
  "issued",
  "pending",
  "reserved",
  "externalized",
  "spent",
  "deleted",
  "error",
);
export type CashuTokenState = typeof CashuTokenState.Type;

// Compile-time: the column union and core's TokenState are the same set.
type _AssertEveryColumnStateIsCoreState = CashuTokenState extends TokenState ? true : never;
type _AssertEveryCoreStateIsColumnState = TokenState extends CashuTokenState ? true : never;
const _columnStatesMatchCore: _AssertEveryColumnStateIsCoreState &
  _AssertEveryCoreStateIsColumnState = true;
void _columnStatesMatchCore;

export const linkySchema = {
  /** `contacts` domain — one row per address-book entry. */
  contact: {
    id: ContactId,
    /** Display name. */
    name: nullOr(NonEmptyString1000),
    /** NIP-19 npub of the contact (chat identity). */
    npub: nullOr(NonEmptyString1000),
    /** Lightning address (payments). */
    lnAddress: nullOr(NonEmptyString1000),
    /** Optional group/label the contact is filed under. */
    groupName: nullOr(NonEmptyString1000),
    /** Unix seconds when the contact was archived; null = active. */
    archivedAtSec: nullOr(PositiveInt),
  },

  /**
   * `wallet` domain — one row per Cashu token held by the wallet (the #33
   * `TokenRecord` shape). The serialized token is BEARER MATERIAL: it lives
   * in this per-lane-encrypted table on purpose (same as the PoC) and must
   * never be logged or embedded in errors.
   */
  cashuToken: {
    id: CashuTokenId,
    /** The CURRENT serialized Cashu token (post-swap encoding). Secret. */
    token: NonEmptyString,
    /** Normalized mint URL (core `normalizeMintUrl`); repo-enforced. */
    mint: nullOr(NonEmptyString1000),
    /** Currency unit, e.g. "sat". */
    unit: nullOr(NonEmptyString100),
    /** Total amount in `unit` when known. */
    amount: nullOr(PositiveInt),
    /** #33 token state, constrained to the 8-state union. */
    state: nullOr(CashuTokenState),
    /** Last error message; meaningful while `state === "error"`. */
    error: nullOr(NonEmptyString1000),
  },

  /**
   * `wallet` domain — one row per known mint (`mints.fetch-info`): the
   * normalized URL plus the cached NUT-06 info (display name, icon, fee
   * hints, raw payload) and when it was fetched. Mints are wallet-domain
   * data (they describe where the wallet's value lives), so they sync on
   * the wallet lane next to the tokens. The single main-mint PREFERENCE is
   * deliberately NOT a flag on these rows — see `MintsRepository`.
   */
  cashuMint: {
    id: CashuMintId,
    /** Normalized mint URL (core `normalizeMintUrl`) — unique per store, repo-enforced. */
    url: NonEmptyString1000,
    /** Display name from NUT-06 info. */
    name: nullOr(NonEmptyString1000),
    /** Icon URL from NUT-06 info. */
    iconUrl: nullOr(NonEmptyString1000),
    /** Raw NUT-06 info payload, JSON-serialized. */
    infoJson: nullOr(NonEmptyString),
    /** Extracted fee hints (e.g. ppk), JSON-serialized. */
    feesJson: nullOr(NonEmptyString),
    /** Unix seconds when the cached info was last fetched. */
    infoFetchedAtSec: nullOr(PositiveInt),
  },

  /**
   * `messages` domain — one row per decrypted NIP-17 chat message.
   *
   * Dedup key is `rumorId` (unique per store, enforced by
   * `MessagesRepository.applyChatEvent`). No retention caps: the PoC's
   * 500/contact limit is intentionally dropped (`chat.retention`); storage
   * is bounded by sync storage rotation (#54), not by deleting history.
   */
  message: {
    id: MessageId,
    /** Inner (rumor, unsigned kind 14) event id — THE de-duplication key. */
    rumorId: NonEmptyString1000,
    /** NIP-19 npub of the conversation peer (contact or unknown sender). */
    peerNpub: NonEmptyString1000,
    /** "in" | "out". */
    direction: NonEmptyString100,
    /** Decrypted plaintext content (current, i.e. after edits). */
    content: NonEmptyString,
    /** NIP-19 npub of the rumor author; null for local placeholders. */
    senderNpub: nullOr(NonEmptyString1000),
    /** Gift-wrap event id (kind 1059); null until the wrap is known. */
    wrapId: nullOr(NonEmptyString1000),
    /** `created_at` (unix seconds) of the inner event. */
    sentAtSec: PositiveInt,
    /** "pending" | "sent" for optimistic sends; null once settled. */
    status: nullOr(NonEmptyString100),
    /** Rumor id of the message this one replies to (NIP-10 style). */
    replyToRumorId: nullOr(NonEmptyString1000),
    /** Unix seconds of the latest applied edit; null = never edited. */
    editedAtSec: nullOr(PositiveInt),
    /**
     * JSON array of applied edits, oldest first:
     * `[{ editId, previousContent, editedAtSec }]`. The first entry's
     * `previousContent` is the original content — preserved locally per the
     * feature map (`chat.edit-message`). `editId` (the edit event's rumor
     * id) makes re-applied edit events no-ops.
     */
    editHistoryJson: nullOr(NonEmptyString),
  },

  /**
   * `messages` domain — one row per NIP-17 emoji reaction event. Display
   * semantics ("latest reaction per person", `chat.react`) are a query
   * concern: all reaction events are kept (deduped by `rumorId`), and
   * `MessagesRepository.latestReactions` reduces to one per reactor.
   */
  reaction: {
    id: ReactionId,
    /** The reaction event's own rumor id — de-duplication key. */
    rumorId: NonEmptyString1000,
    /** Rumor id of the message being reacted to. */
    messageRumorId: NonEmptyString1000,
    /** NIP-19 npub of the reactor. */
    reactorNpub: NonEmptyString1000,
    emoji: NonEmptyString100,
    /** `created_at` (unix seconds) of the reaction event. */
    sentAtSec: PositiveInt,
    /** "pending" | "sent" for optimistic sends; null once settled. */
    status: nullOr(NonEmptyString100),
  },

  /**
   * `transactions` domain — one row per wallet-history entry (`tx.record`):
   * outcome records including errors and intermediate phases. Shape follows
   * the PoC's phase-rich `transaction` table (direction, status, category,
   * method, phase, amounts, fees, mint, contact link, error, detailsJson);
   * the PoC's `iconKind`/`pendingLabel` presentation columns are intentionally
   * dropped — both derive from category/method/status in the UI.
   *
   * `tx.details` contract: `detailsJson` (and `error`/`note`) must never
   * contain secrets, raw proofs, or private keys — callers serialize
   * support-safe details only.
   */
  transaction: {
    id: TransactionId,
    /** Unix seconds when the transaction happened (domain time). */
    happenedAtSec: PositiveInt,
    /** "in" | "out". */
    direction: NonEmptyString100,
    /** e.g. "pending" | "completed" | "failed". */
    status: NonEmptyString100,
    /** e.g. "cashu" | "lightning" | "internal". */
    category: NonEmptyString100,
    /** Payment method detail, e.g. "token" | "invoice" | "lnaddress". */
    method: nullOr(NonEmptyString100),
    /**
     * Last reached flow phase (`tx.record` "intermediate phases"), e.g.
     * "quote" | "swap" | "melt" | "deliver" | "settle". Free-form: phases
     * are per-flow telemetry breadcrumbs, not a state machine.
     */
    phase: nullOr(NonEmptyString100),
    /** Amount in `unit` when known. */
    amount: nullOr(PositiveInt),
    /** Fee paid, in `unit`. */
    feeAmount: nullOr(PositiveInt),
    unit: nullOr(NonEmptyString100),
    /** Normalized mint URL when known (`tx.link-mint`). */
    mint: nullOr(NonEmptyString1000),
    /** Counterparty contact, when the transaction relates to one (`tx.link-contact`). */
    contactId: nullOr(ContactId),
    note: nullOr(NonEmptyString1000),
    /** Error message for failed/partial outcomes — kept for support. */
    error: nullOr(NonEmptyString1000),
    /** Free-form JSON details payload (method-specific, support-safe). */
    detailsJson: nullOr(NonEmptyString),
  },

  /**
   * `identity` domain — Nostr identities the user activated.
   *
   * M2 mirror of the custom-key override (#20): the local source of truth
   * is SecureStorage (`linky.identity.customNostrKey.v1`, owned by
   * `@linky/core` `domain/identity/customNostrKey.ts`); when the Evolu
   * store joins the app runtime (#21+), activate/revert additionally
   * upsert this row so the override syncs across devices like the PoC
   * (encrypted per-lane; PoC table `nostrIdentity`, row
   * `active-nostr-identity`, column `switchedAtSec` = our `activatedAtSec`).
   */
  nostrIdentity: {
    id: NostrIdentityId,
    /** NIP-19 nsec. Secret — never log query results from this table. */
    nsec: NonEmptyString1000,
    /** NIP-19 npub matching `nsec`. */
    npub: nullOr(NonEmptyString1000),
    /** "derived" (from master identity) | "custom" (pasted nsec override). */
    source: nullOr(NonEmptyString100),
    /** Unix seconds when this identity became the active one (null = derived). */
    activatedAtSec: nullOr(PositiveInt),
  },

  /** `meta` domain — small key/value coordination entries (lane routing, schema flags). */
  metaEntry: {
    id: MetaEntryId,
    key: NonEmptyString100,
    value: NonEmptyString1000,
  },

  /**
   * `contacts` domain — blocked senders (`contacts.block`). Synced on
   * purpose (unlike the PoC's localStorage list): the block must survive
   * restore and reach every device so sync can never recreate a blocked
   * thread. Deliberately NOT on the `messages` lane — storage rotation
   * (#54) must never rotate a block away. Unblock = Evolu soft delete
   * (tombstone syncs too).
   */
  blockedSender: {
    id: BlockedSenderId,
    /** NIP-19 npub of the blocked sender. */
    npub: NonEmptyString1000,
    /** Unix seconds when the block was created. */
    blockedAtSec: nullOr(PositiveInt),
  },

  /**
   * LOCAL-ONLY (leading `_`, never syncs) — one row per unknown thread:
   * an inbound conversation from a sender who is not a saved contact
   * (`contacts.unknown`). The messages themselves are in the synced
   * `message` table; this row is only the device-local inbox entry.
   * Removing it (promote/block) physically deletes the row.
   */
  _unknownThread: {
    id: UnknownThreadId,
    /** NIP-19 npub of the unknown sender (unique per store, repo-enforced). */
    npub: NonEmptyString1000,
    /** Unix seconds of the message that created the thread. */
    firstSeenAtSec: nullOr(PositiveInt),
    /** Unix seconds of the latest message in the thread. */
    lastActivityAtSec: nullOr(PositiveInt),
  },

  /**
   * LOCAL-ONLY (leading `_`, never syncs) — NUT-13 deterministic counters
   * and restore cursors for the #32 `CounterStore` port, one row per
   * canonical counter key (`counterStoreKey`: prefix + mint + unit +
   * keyset).
   *
   * DELIBERATELY DEVICE-LOCAL, matching the PoC (which keeps counters in
   * localStorage under `linky.cashu.detCounter.v1` /
   * `linky.cashu.restoreCursor.v1`, never in Evolu). Syncing counters would
   * be a fund-safety hazard: an Evolu column is a last-writer-wins register,
   * so a device holding a LOWER counter could overwrite another device's
   * higher value after a concurrent bump — and a counter moving backwards
   * means reused blinded messages. Counters are a per-device fast path; a
   * fresh device after restore starts at 0 and the engine's NUT-09 restore
   * scan + `ensureCounterAtLeast` re-raise them safely.
   */
  _cashuCounter: {
    id: CashuCounterId,
    /** Canonical counter key (core `counterStoreKey` output). */
    key: NonEmptyString1000,
    /** Stringified non-negative integer. */
    value: NonEmptyString100,
  },
};

export type LinkySchema = typeof linkySchema;

/** All Linky table names. */
export type LinkyTableName = keyof LinkySchema;

/** Local-only tables (leading `_`): Evolu never syncs them. */
export type LocalOnlyTableName = Extract<LinkyTableName, `_${string}`>;

/** Tables that sync on a domain owner lane. */
export type SyncedTableName = Exclude<LinkyTableName, LocalOnlyTableName>;

/** Whether a table is local-only (leading `_`, Evolu convention). */
export const isLocalOnlyTable = (table: LinkyTableName): table is LocalOnlyTableName =>
  table.startsWith("_");
