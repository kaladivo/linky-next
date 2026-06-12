/**
 * UnknownThreadsRepository — local-only unknown threads (issue #25,
 * `contacts.unknown`).
 *
 * An unknown thread is the device-local inbox entry for an inbound
 * conversation whose sender is not a saved contact. It lives in the
 * `_unknownThread` table (leading `_` = Evolu local-only: never synced, no
 * CRDT history, `isDeleted` physically removes the row). The conversation's
 * messages stay in the synced `message` table keyed by `peerNpub`, so:
 *
 * - `contacts.promote-unknown`: create the contact (ContactsRepository),
 *   then `remove(npub)` here — the messages need no migration because the
 *   conversation is matched to the contact by npub.
 * - `contacts.delete-to-unknown`: soft-delete the contact, then
 *   `create(npub)` here — history is preserved under the unknown thread.
 * - `contacts.block`: BlocksRepository.block, then `remove(npub)` here;
 *   MessagesRepository drops further inbound events from the blocked npub,
 *   so the thread cannot be recreated (not even by sync — the thread row
 *   never syncs in the first place).
 *
 * Thread creation on inbound messages happens in
 * `MessagesRepository.applyChatEvent`; this repository covers the explicit
 * flows above plus the inbox list.
 */
import type { LinkyStore } from "../createLinkyStore";
import { loadConversationPreviews } from "./messagesRepository";
import type { ConversationPreview } from "./messagesRepository";
import { repoErr, repoOk } from "./repository";
import type { RepoResult } from "./repository";

/** One unknown thread as core sees it. Plain data, no Evolu types. */
export interface UnknownThreadRecord {
  readonly id: string;
  /** NIP-19 npub of the unknown sender. */
  readonly npub: string;
  readonly firstSeenAtSec: number | null;
  readonly lastActivityAtSec: number | null;
}

/** Inbox list item: thread + last message preview. */
export interface UnknownThreadListItem {
  readonly thread: UnknownThreadRecord;
  readonly preview: ConversationPreview | null;
}

/** A thread value failed schema validation (e.g. empty npub). */
export interface UnknownThreadValidationError {
  readonly _tag: "UnknownThreadValidationError";
  readonly reason: string;
}

export interface UnknownThreadsRepository {
  /**
   * Ensures a thread for `npub` exists (idempotent — one thread per npub).
   * Used by `contacts.delete-to-unknown`.
   */
  readonly create: (
    npub: string,
    atSec?: number,
  ) => Promise<RepoResult<{ readonly id: string }, UnknownThreadValidationError>>;
  /** The thread for `npub`, or null. */
  readonly getByNpub: (npub: string) => Promise<UnknownThreadRecord | null>;
  /**
   * The thread with this id, or null — the unknown chat screen resolves
   * its route param with this (#28).
   */
  readonly getById: (id: string) => Promise<UnknownThreadRecord | null>;
  /** All unknown threads, latest activity first, with last-message previews. */
  readonly list: () => Promise<ReadonlyArray<UnknownThreadListItem>>;
  /**
   * Physically removes the thread for `npub` (local-only table — no
   * tombstone). Used by promote-unknown and block. Idempotent.
   */
  readonly remove: (npub: string) => Promise<{ readonly removed: boolean }>;
}

const asParam = (value: string | number): never => value as never;

interface ThreadRowLike {
  readonly id: unknown;
  readonly npub: unknown;
  readonly firstSeenAtSec: unknown;
  readonly lastActivityAtSec: unknown;
}

const toRecord = (row: ThreadRowLike): UnknownThreadRecord => ({
  id: String(row.id),
  npub: String(row.npub),
  firstSeenAtSec: row.firstSeenAtSec === null ? null : Number(row.firstSeenAtSec),
  lastActivityAtSec: row.lastActivityAtSec === null ? null : Number(row.lastActivityAtSec),
});

export const createUnknownThreadsRepository = (store: LinkyStore): UnknownThreadsRepository => {
  const rowByNpub = async (npub: string) => {
    const query = store.evolu.createQuery((db) =>
      db.selectFrom("_unknownThread").selectAll().where("npub", "=", asParam(npub)).limit(1),
    );
    const rows = await store.evolu.loadQuery(query);
    return rows[0] ?? null;
  };

  return {
    create: async (npub, atSec) => {
      const existing = await rowByNpub(npub);
      if (existing !== null) return repoOk({ id: String(existing.id) });
      const result = store.insert("_unknownThread", {
        npub,
        ...(atSec === undefined ? {} : { firstSeenAtSec: atSec, lastActivityAtSec: atSec }),
      });
      if (!result.ok) {
        return repoErr({
          _tag: "UnknownThreadValidationError" as const,
          reason: "npub must be a non-empty string (max 1000)",
        });
      }
      return repoOk({ id: String(result.value.id) });
    },

    getByNpub: async (npub) => {
      const row = await rowByNpub(npub);
      return row === null ? null : toRecord(row);
    },

    getById: async (id) => {
      const query = store.evolu.createQuery((db) =>
        db.selectFrom("_unknownThread").selectAll().where("id", "=", asParam(id)).limit(1),
      );
      const rows = await store.evolu.loadQuery(query);
      const row = rows[0];
      return row === undefined ? null : toRecord(row);
    },

    list: async () => {
      const query = store.evolu.createQuery((db) =>
        db.selectFrom("_unknownThread").selectAll().orderBy("lastActivityAtSec", "desc"),
      );
      const rows = await store.evolu.loadQuery(query);
      const threads = rows.map(toRecord);
      const previews = await loadConversationPreviews(
        store,
        threads.map((thread) => thread.npub),
      );
      return threads.map((thread) => ({
        thread,
        preview: previews.get(thread.npub) ?? null,
      }));
    },

    remove: async (npub) => {
      const existing = await rowByNpub(npub);
      if (existing === null) return { removed: false };
      // Local-only table: Evolu physically deletes the row on isDeleted.
      store.update("_unknownThread", { id: existing.id, isDeleted: 1 });
      return { removed: true };
    },
  };
};
