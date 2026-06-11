/**
 * Linky Evolu schema — the base tables for all six sync domains (issue #15).
 *
 * ## Domain map
 *
 * Every table belongs to exactly one sync domain (see `tableSyncDomain` in
 * `domains.ts`); all of a domain's rows are written to that domain's derived
 * owner lane (issue #13: master secret -> lane mnemonic -> Evolu owner).
 *
 * | Table           | Domain         | Rows                                  |
 * | --------------- | -------------- | ------------------------------------- |
 * | `contact`       | `contacts`     | Address-book entries                  |
 * | `cashuToken`    | `wallet`       | Cashu ecash tokens                    |
 * | `message`       | `messages`     | Decrypted NIP-17 chat messages        |
 * | `transaction`   | `transactions` | Wallet history entries                |
 * | `nostrIdentity` | `identity`     | Active/previous Nostr identities      |
 * | `metaEntry`     | `meta`         | Cross-device key/value coordination   |
 *
 * Columns are the minimal-but-real base set informed by the PoC
 * (`linky-poc/apps/web-app/src/evolu.ts`); they grow with issues #25/#35.
 * Evolu schema evolution is additive, so extending tables later is safe.
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
} from "@evolu/common";

export const ContactId = id("Contact");
export type ContactId = typeof ContactId.Type;

export const CashuTokenId = id("CashuToken");
export type CashuTokenId = typeof CashuTokenId.Type;

export const MessageId = id("Message");
export type MessageId = typeof MessageId.Type;

export const TransactionId = id("Transaction");
export type TransactionId = typeof TransactionId.Type;

export const NostrIdentityId = id("NostrIdentity");
export type NostrIdentityId = typeof NostrIdentityId.Type;

export const MetaEntryId = id("MetaEntry");
export type MetaEntryId = typeof MetaEntryId.Type;

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

  /** `wallet` domain — one row per Cashu token held by the wallet. */
  cashuToken: {
    id: CashuTokenId,
    /** The current (accepted) serialized Cashu token. */
    token: NonEmptyString,
    /** Mint URL, when the token references exactly one mint. */
    mint: nullOr(NonEmptyString1000),
    /** Currency unit, e.g. "sat". */
    unit: nullOr(NonEmptyString100),
    /** Total amount in `unit` when known. */
    amount: nullOr(PositiveInt),
    /** "pending" | "accepted" | "error". */
    state: nullOr(NonEmptyString100),
    /** Last error message for state "error". */
    error: nullOr(NonEmptyString1000),
  },

  /** `messages` domain — one row per decrypted NIP-17 chat message. */
  message: {
    id: MessageId,
    contactId: ContactId,
    /** "in" | "out". */
    direction: NonEmptyString100,
    /** Decrypted plaintext content. */
    content: NonEmptyString,
    /** Gift-wrap event id (kind 1059) — de-duplication key. */
    wrapId: NonEmptyString1000,
    /** Inner (rumor) event id (kind 14) when available. */
    rumorId: nullOr(NonEmptyString1000),
    /** Sender pubkey hex of the inner event; null for local placeholders. */
    senderPubkey: nullOr(NonEmptyString1000),
    /** `created_at` (unix seconds) of the inner event. */
    sentAtSec: PositiveInt,
    /** "pending" | "sent" for optimistic sends; null once settled. */
    status: nullOr(NonEmptyString100),
  },

  /** `transactions` domain — one row per wallet-history entry. */
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
    /** Amount in `unit` when known. */
    amount: nullOr(PositiveInt),
    /** Fee paid, in `unit`. */
    feeAmount: nullOr(PositiveInt),
    unit: nullOr(NonEmptyString100),
    mint: nullOr(NonEmptyString1000),
    /** Counterparty contact, when the transaction relates to one. */
    contactId: nullOr(ContactId),
    note: nullOr(NonEmptyString1000),
    /** Free-form JSON details payload (method-specific). */
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
};

export type LinkySchema = typeof linkySchema;

/** All Linky table names. */
export type LinkyTableName = keyof LinkySchema;
