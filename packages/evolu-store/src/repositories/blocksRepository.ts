/**
 * BlocksRepository — blocked senders (issue #25, `contacts.block`).
 *
 * Blocks live in the synced `blockedSender` table on the CONTACTS lane (the
 * PoC kept them in localStorage; the rewrite syncs them so a block made on
 * one device reaches every device and survives restore). They are
 * deliberately not on the messages lane: storage rotation (#54) must never
 * rotate a block away.
 *
 * Enforcement is in `MessagesRepository.applyChatEvent`: every inbound chat
 * event from a blocked npub is dropped before any row is written, which is
 * what "blocking prevents sync from recreating the thread" means at the
 * storage level. `isBlocked` is the query the inbox workflow uses.
 *
 * Unblock is an Evolu soft delete, so the tombstone syncs too and a
 * re-block later creates a fresh row.
 */
import type { LinkyStore } from "../createLinkyStore";
import { isNpubBlocked } from "./messagesRepository";
import { repoErr, repoOk } from "./repository";
import type { RepoResult } from "./repository";

/** One blocked sender as core sees it. Plain data, no Evolu types. */
export interface BlockedSenderRecord {
  readonly id: string;
  /** NIP-19 npub of the blocked sender. */
  readonly npub: string;
  readonly blockedAtSec: number | null;
}

/** A block value failed schema validation (e.g. empty npub). */
export interface BlockValidationError {
  readonly _tag: "BlockValidationError";
  readonly reason: string;
}

export interface BlocksRepository {
  /** Blocks `npub`. Idempotent — re-blocking an active block is a no-op. */
  readonly block: (
    npub: string,
    atSec?: number,
  ) => Promise<RepoResult<{ readonly id: string }, BlockValidationError>>;
  /** Removes the block (soft delete — the tombstone syncs). Idempotent. */
  readonly unblock: (npub: string) => Promise<{ readonly unblocked: boolean }>;
  /** Whether `npub` is currently blocked (the inbox workflow's gate). */
  readonly isBlocked: (npub: string) => Promise<boolean>;
  /** All active blocks, newest first. */
  readonly list: () => Promise<ReadonlyArray<BlockedSenderRecord>>;
}

const asParam = (value: string | number): never => value as never;

export const createBlocksRepository = (store: LinkyStore): BlocksRepository => {
  const activeRowsByNpub = async (npub: string) => {
    const query = store.evolu.createQuery((db) =>
      db
        .selectFrom("blockedSender")
        .selectAll()
        .where("isDeleted", "is not", 1)
        .where("npub", "=", asParam(npub)),
    );
    return store.evolu.loadQuery(query);
  };

  return {
    block: async (npub, atSec) => {
      const existing = await activeRowsByNpub(npub);
      const first = existing[0];
      if (first !== undefined) return repoOk({ id: String(first.id) });
      const result = store.insert("blockedSender", {
        npub,
        ...(atSec === undefined ? {} : { blockedAtSec: atSec }),
      });
      if (!result.ok) {
        return repoErr({
          _tag: "BlockValidationError" as const,
          reason: "npub must be a non-empty string (max 1000)",
        });
      }
      return repoOk({ id: String(result.value.id) });
    },

    unblock: async (npub) => {
      const existing = await activeRowsByNpub(npub);
      for (const row of existing) {
        store.update("blockedSender", { id: row.id, isDeleted: 1 });
      }
      return { unblocked: existing.length > 0 };
    },

    isBlocked: (npub) => isNpubBlocked(store, npub),

    list: async () => {
      const query = store.evolu.createQuery((db) =>
        db
          .selectFrom("blockedSender")
          .selectAll()
          .where("isDeleted", "is not", 1)
          .orderBy("blockedAtSec", "desc")
          .orderBy("createdAt", "desc"),
      );
      const rows = await store.evolu.loadQuery(query);
      return rows.map(
        (row): BlockedSenderRecord => ({
          id: String(row.id),
          npub: String(row.npub),
          blockedAtSec: row.blockedAtSec === null ? null : Number(row.blockedAtSec),
        }),
      );
    },
  };
};
