/**
 * MessagesRepository — chat persistence on the `messages` lane (issue #25).
 *
 * ## The #22 handoff contract (storage side)
 *
 * The NIP-17 engine (#22, in flight on another branch) unwraps, validates,
 * and dedup-keys chat events by **rumor id** (the inner unsigned event id),
 * then hands them to storage as {@link ChatEventInput} values via
 * {@link MessagesRepository.applyChatEvent}. Mapping notes for the merge:
 *
 * - Peers and senders are identified by **NIP-19 npub** here (consistent
 *   with `contact.npub`); the engine converts hex pubkeys before handing
 *   off.
 * - `rumorId` is the engine's dedup key for every event kind (message,
 *   edit, reaction, delete). Storage enforces uniqueness (Evolu has no
 *   unique constraints) and reports duplicates instead of double-applying.
 * - `direction` is computed by the engine ("out" = authored by the active
 *   identity — covers optimistic local sends AND own-device echoes).
 * - Optimistic sends are `kind: "message", direction: "out",
 *   status: "pending"`; when the delivered copy arrives (same rumor id),
 *   `applyChatEvent` acknowledges it (`chat.pending-ack`) — or the engine
 *   calls {@link MessagesRepository.markSent} directly after a relay ack.
 *
 * ## Inbox safety (enforced HERE, in one place)
 *
 * - A blocked sender's inbound events are dropped (`outcome: "blocked"`):
 *   nothing is written, no unknown thread is created or resurrected. This
 *   is the storage half of "blocking prevents sync from recreating the
 *   thread" (`contacts.block`).
 * - An inbound message from a sender who is neither a saved contact nor an
 *   existing unknown thread creates the local-only `_unknownThread` row
 *   (`contacts.unknown`).
 */
import { createFormatTypeError, NonEmptyString1000 } from "@evolu/common";

import type { LinkyStore } from "../createLinkyStore";
import { repoErr, repoOk } from "./repository";
import type { RepoResult } from "./repository";

// ─── #22 handoff contract ────────────────────────────────────────────────

/** Fields shared by every validated chat event the NIP-17 engine emits. */
export interface ChatEventBase {
  /** Rumor (inner unsigned event) id — globally unique, THE dedup key. */
  readonly rumorId: string;
  /** NIP-19 npub of the conversation peer (the other party). */
  readonly peerNpub: string;
  /** NIP-19 npub of the event author. */
  readonly senderNpub: string;
  /** "in" = peer authored, "out" = own event (optimistic send or echo). */
  readonly direction: "in" | "out";
  /** `created_at` (unix seconds) of the rumor. */
  readonly sentAtSec: number;
  /** Gift-wrap (kind 1059) event id when the event arrived from a relay. */
  readonly wrapId?: string;
}

export interface ChatMessageEvent extends ChatEventBase {
  readonly kind: "message";
  readonly content: string;
  /** Rumor id of the message this one replies to. */
  readonly replyToRumorId?: string;
  /** "pending" for optimistic sends; defaults to "sent". */
  readonly status?: "pending" | "sent";
}

export interface ChatEditEvent extends ChatEventBase {
  readonly kind: "edit";
  /** Rumor id of the message being edited. */
  readonly targetRumorId: string;
  /** The new content. */
  readonly content: string;
}

export interface ChatReactionEvent extends ChatEventBase {
  readonly kind: "reaction";
  /** Rumor id of the message being reacted to. */
  readonly targetRumorId: string;
  readonly emoji: string;
}

export interface ChatDeleteEvent extends ChatEventBase {
  readonly kind: "delete";
  /** Rumor ids of the messages and/or reactions being deleted. */
  readonly targetRumorIds: ReadonlyArray<string>;
}

/** A validated chat event as the NIP-17 engine (#22) hands it to storage. */
export type ChatEventInput =
  | ChatMessageEvent
  | ChatEditEvent
  | ChatReactionEvent
  | ChatDeleteEvent;

/** What applying a chat event did. */
export interface ChatEventApplied {
  /**
   * - "applied": the event was stored / its effect took place.
   * - "duplicate": the rumor id (or edit/delete effect) was already known;
   *   nothing was double-applied.
   * - "blocked": inbound event from a blocked sender; dropped entirely.
   * - "target-missing": edit/delete whose target message is unknown.
   */
  readonly outcome: "applied" | "duplicate" | "blocked" | "target-missing";
  /** True when this event created a new local-only unknown thread. */
  readonly unknownThreadCreated: boolean;
  /** True when a pending optimistic message was acknowledged as sent. */
  readonly acknowledgedPending: boolean;
}

// ─── Records ─────────────────────────────────────────────────────────────

/** One applied edit, oldest first in {@link MessageRecord.editHistory}. */
export interface MessageEdit {
  /** Rumor id of the edit event (dedup key for re-applied edits). */
  readonly editId: string;
  /** Content the message had before this edit (first entry = original). */
  readonly previousContent: string;
  readonly editedAtSec: number;
}

/** One chat message as core sees it. Plain data, no Evolu types. */
export interface MessageRecord {
  readonly id: string;
  readonly rumorId: string;
  readonly peerNpub: string;
  readonly direction: "in" | "out";
  /** Current content (after edits). */
  readonly content: string;
  readonly senderNpub: string | null;
  readonly wrapId: string | null;
  readonly sentAtSec: number;
  readonly status: "pending" | "sent" | null;
  readonly replyToRumorId: string | null;
  readonly editedAtSec: number | null;
  /** Applied edits, oldest first; empty when never edited. */
  readonly editHistory: ReadonlyArray<MessageEdit>;
}

/** One reaction event as stored. */
export interface ReactionRecord {
  readonly id: string;
  readonly rumorId: string;
  readonly messageRumorId: string;
  readonly reactorNpub: string;
  readonly emoji: string;
  readonly sentAtSec: number;
  readonly status: "pending" | "sent" | null;
}

/**
 * Last-message preview for contact/unknown-thread lists. A discriminated
 * union on `kind` so chat-payment previews (token receipts, #35+) can be
 * added without changing consumers.
 */
export interface MessagePreview {
  readonly kind: "message";
  readonly rumorId: string;
  readonly direction: "in" | "out";
  readonly content: string;
  readonly sentAtSec: number;
}

export type ConversationPreview = MessagePreview;

/** Newest-first message page request. */
export interface MessagePageRequest {
  readonly peerNpub: string;
  readonly limit: number;
  /** Continue after this cursor (from a previous page's `nextCursor`). */
  readonly cursor?: MessageCursor;
}

/** Opaque-ish page cursor: position of the last item of the previous page. */
export interface MessageCursor {
  readonly sentAtSec: number;
  readonly id: string;
}

export interface MessagePage {
  /** Newest first. */
  readonly items: ReadonlyArray<MessageRecord>;
  /** Cursor for the next (older) page; null when this page was the last. */
  readonly nextCursor: MessageCursor | null;
}

/** A chat event value failed schema validation. */
export interface ChatEventValidationError {
  readonly _tag: "ChatEventValidationError";
  readonly reason: string;
}

export interface MessagesRepository {
  /**
   * Applies one validated chat event from the NIP-17 engine. Idempotent for
   * every event kind: re-applying the same event (same rumor id) is reported
   * as "duplicate" and never double-applies.
   */
  readonly applyChatEvent: (
    event: ChatEventInput,
  ) => Promise<RepoResult<ChatEventApplied, ChatEventValidationError>>;
  /** Marks an optimistic message as sent (relay ack path). */
  readonly markSent: (
    rumorId: string,
    wrapId?: string,
  ) => Promise<RepoResult<{ readonly acknowledged: boolean }, ChatEventValidationError>>;
  /** The message with this rumor id, or null. Excludes deleted messages. */
  readonly getByRumorId: (rumorId: string) => Promise<MessageRecord | null>;
  /** One conversation page, newest first, cursor-based. */
  readonly listPage: (request: MessagePageRequest) => Promise<MessagePage>;
  /**
   * The visible reactions of a message: the latest reaction per person
   * (`chat.react` — one visible reaction per user).
   */
  readonly latestReactions: (messageRumorId: string) => Promise<ReadonlyArray<ReactionRecord>>;
}

// ─── Implementation ──────────────────────────────────────────────────────

const formatTypeError = createFormatTypeError();

/** Casts a validated plain value to a branded query-builder value. */
const asParam = (value: string | number): never => value as never;

const parseEditHistory = (json: unknown): ReadonlyArray<MessageEdit> => {
  if (typeof json !== "string" || json.length === 0) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry): MessageEdit[] => {
      if (typeof entry !== "object" || entry === null) return [];
      const { editId, previousContent, editedAtSec } = entry as Record<string, unknown>;
      if (typeof editId !== "string" || typeof previousContent !== "string") return [];
      return [
        {
          editId,
          previousContent,
          editedAtSec: typeof editedAtSec === "number" ? editedAtSec : 0,
        },
      ];
    });
  } catch {
    return [];
  }
};

const toDirection = (value: unknown): "in" | "out" => (value === "out" ? "out" : "in");

const toStatus = (value: unknown): "pending" | "sent" | null =>
  value === "pending" || value === "sent" ? value : null;

interface MessageRowLike {
  readonly id: unknown;
  readonly rumorId: unknown;
  readonly peerNpub: unknown;
  readonly direction: unknown;
  readonly content: unknown;
  readonly senderNpub: unknown;
  readonly wrapId: unknown;
  readonly sentAtSec: unknown;
  readonly status: unknown;
  readonly replyToRumorId: unknown;
  readonly editedAtSec: unknown;
  readonly editHistoryJson: unknown;
}

const toMessageRecord = (row: MessageRowLike): MessageRecord => ({
  id: String(row.id),
  rumorId: String(row.rumorId),
  peerNpub: String(row.peerNpub),
  direction: toDirection(row.direction),
  content: String(row.content),
  senderNpub: row.senderNpub === null ? null : String(row.senderNpub),
  wrapId: row.wrapId === null ? null : String(row.wrapId),
  sentAtSec: Number(row.sentAtSec),
  status: toStatus(row.status),
  replyToRumorId: row.replyToRumorId === null ? null : String(row.replyToRumorId),
  editedAtSec: row.editedAtSec === null ? null : Number(row.editedAtSec),
  editHistory: parseEditHistory(row.editHistoryJson),
});

/**
 * Loads the latest visible message per conversation for the given peer
 * npubs. Shared by the contact list and the unknown-thread list.
 */
export const loadConversationPreviews = async (
  store: LinkyStore,
  peerNpubs: ReadonlyArray<string>,
): Promise<ReadonlyMap<string, ConversationPreview>> => {
  const previews = new Map<string, ConversationPreview>();
  if (peerNpubs.length === 0) return previews;
  // SQLite guarantees that with a bare max() aggregate the other selected
  // columns come from the max row.
  const query = store.evolu.createQuery((db) =>
    db
      .selectFrom("message")
      .selectAll()
      .select((eb) => eb.fn.max("sentAtSec").as("lastSentAtSec"))
      .where("isDeleted", "is not", 1)
      .where("peerNpub", "in", peerNpubs.map(asParam))
      .groupBy("peerNpub"),
  );
  const rows = await store.evolu.loadQuery(query);
  for (const row of rows) {
    previews.set(String(row.peerNpub), {
      kind: "message",
      rumorId: String(row.rumorId),
      direction: toDirection(row.direction),
      content: String(row.content),
      sentAtSec: Number(row.sentAtSec),
    });
  }
  return previews;
};

/** True when an active (non-deleted) blocked-sender row exists for `npub`. */
export const isNpubBlocked = async (store: LinkyStore, npub: string): Promise<boolean> => {
  const query = store.evolu.createQuery((db) =>
    db
      .selectFrom("blockedSender")
      .select("id")
      .where("isDeleted", "is not", 1)
      .where("npub", "=", asParam(npub))
      .limit(1),
  );
  const rows = await store.evolu.loadQuery(query);
  return rows.length > 0;
};

export const createMessagesRepository = (store: LinkyStore): MessagesRepository => {
  // Dedup lookups must see soft-deleted rows too: a deleted message that
  // re-arrives via another sync path must stay deleted, not resurrect.
  const messageByRumorId = async (rumorId: string) => {
    const query = store.evolu.createQuery((db) =>
      db.selectFrom("message").selectAll().where("rumorId", "=", asParam(rumorId)).limit(1),
    );
    const rows = await store.evolu.loadQuery(query);
    return rows[0] ?? null;
  };

  const reactionByRumorId = async (rumorId: string) => {
    const query = store.evolu.createQuery((db) =>
      db.selectFrom("reaction").selectAll().where("rumorId", "=", asParam(rumorId)).limit(1),
    );
    const rows = await store.evolu.loadQuery(query);
    return rows[0] ?? null;
  };

  /** Reactions whose OWN rumor id is targeted (NIP-09 deletes by event id). */
  const reactionsByRumorIds = async (targets: ReadonlyArray<string>) => {
    if (targets.length === 0) return [];
    const query = store.evolu.createQuery((db) =>
      db
        .selectFrom("reaction")
        .selectAll()
        .where("rumorId", "in", targets.map(asParam)),
    );
    return store.evolu.loadQuery(query);
  };

  const contactExistsByNpub = async (npub: string): Promise<boolean> => {
    const query = store.evolu.createQuery((db) =>
      db
        .selectFrom("contact")
        .select("id")
        .where("isDeleted", "is not", 1)
        .where("npub", "=", asParam(npub))
        .limit(1),
    );
    const rows = await store.evolu.loadQuery(query);
    return rows.length > 0;
  };

  const unknownThreadByNpub = async (npub: string) => {
    const query = store.evolu.createQuery((db) =>
      db.selectFrom("_unknownThread").selectAll().where("npub", "=", asParam(npub)).limit(1),
    );
    const rows = await store.evolu.loadQuery(query);
    return rows[0] ?? null;
  };

  const validationErr = (reason: string) =>
    repoErr({ _tag: "ChatEventValidationError" as const, reason });

  /**
   * Ensures the unknown-thread bookkeeping for an inbound message from a
   * non-contact: creates the local-only thread row, or bumps its activity.
   */
  const upsertUnknownThread = async (
    peerNpub: string,
    sentAtSec: number,
  ): Promise<{ created: boolean }> => {
    const existing = await unknownThreadByNpub(peerNpub);
    if (existing === null) {
      store.insert("_unknownThread", {
        npub: peerNpub,
        firstSeenAtSec: sentAtSec,
        lastActivityAtSec: sentAtSec,
      });
      return { created: true };
    }
    const lastActivity = existing.lastActivityAtSec === null ? 0 : Number(existing.lastActivityAtSec);
    if (sentAtSec > lastActivity) {
      store.update("_unknownThread", { id: existing.id, lastActivityAtSec: sentAtSec });
    }
    return { created: false };
  };

  const applied = (
    outcome: ChatEventApplied["outcome"],
    flags?: Partial<Omit<ChatEventApplied, "outcome">>,
  ): ChatEventApplied => ({
    outcome,
    unknownThreadCreated: flags?.unknownThreadCreated ?? false,
    acknowledgedPending: flags?.acknowledgedPending ?? false,
  });

  const applyMessage = async (event: ChatMessageEvent) => {
    const existing = await messageByRumorId(event.rumorId);
    if (existing !== null) {
      // chat.pending-ack: the delivered copy of an optimistic send arrived.
      if (existing.status === "pending") {
        const result = store.update("message", {
          id: existing.id,
          status: "sent",
          ...(event.wrapId === undefined ? {} : { wrapId: event.wrapId }),
        });
        if (!result.ok) return validationErr(formatTypeError(result.error as never));
        return repoOk(applied("duplicate", { acknowledgedPending: true }));
      }
      return repoOk(applied("duplicate"));
    }

    const result = store.insert("message", {
      rumorId: event.rumorId,
      peerNpub: event.peerNpub,
      direction: event.direction,
      content: event.content,
      senderNpub: event.senderNpub,
      sentAtSec: event.sentAtSec,
      status: event.status ?? "sent",
      ...(event.wrapId === undefined ? {} : { wrapId: event.wrapId }),
      ...(event.replyToRumorId === undefined ? {} : { replyToRumorId: event.replyToRumorId }),
    });
    if (!result.ok) return validationErr(formatTypeError(result.error as never));

    // contacts.unknown: an inbound message from a non-contact creates (or
    // bumps) the local-only unknown thread.
    let unknownThreadCreated = false;
    if (event.direction === "in" && !(await contactExistsByNpub(event.peerNpub))) {
      unknownThreadCreated = (await upsertUnknownThread(event.peerNpub, event.sentAtSec)).created;
    }
    return repoOk(applied("applied", { unknownThreadCreated }));
  };

  const applyEdit = async (event: ChatEditEvent) => {
    const target = await messageByRumorId(event.targetRumorId);
    if (target === null) return repoOk(applied("target-missing"));

    const history = parseEditHistory(target.editHistoryJson);
    if (history.some((edit) => edit.editId === event.rumorId)) {
      return repoOk(applied("duplicate"));
    }

    // Append to history unconditionally (the original content is the first
    // entry's previousContent); only move `content` forward when this edit
    // is not older than the latest applied one (out-of-order arrivals).
    const newHistory: MessageEdit[] = [
      ...history,
      {
        editId: event.rumorId,
        previousContent: String(target.content),
        editedAtSec: event.sentAtSec,
      },
    ];
    const latestAppliedAtSec = target.editedAtSec === null ? 0 : Number(target.editedAtSec);
    const supersedes = event.sentAtSec >= latestAppliedAtSec;
    const result = store.update("message", {
      id: target.id,
      editHistoryJson: JSON.stringify(newHistory),
      ...(supersedes ? { content: event.content, editedAtSec: event.sentAtSec } : {}),
    });
    if (!result.ok) return validationErr(formatTypeError(result.error as never));
    return repoOk(applied("applied"));
  };

  const applyReaction = async (event: ChatReactionEvent) => {
    const existing = await reactionByRumorId(event.rumorId);
    if (existing !== null) return repoOk(applied("duplicate"));
    const result = store.insert("reaction", {
      rumorId: event.rumorId,
      messageRumorId: event.targetRumorId,
      reactorNpub: event.senderNpub,
      emoji: event.emoji,
      sentAtSec: event.sentAtSec,
      status: "sent",
    });
    if (!result.ok) return validationErr(formatTypeError(result.error as never));
    return repoOk(applied("applied"));
  };

  const applyDelete = async (event: ChatDeleteEvent) => {
    if (event.targetRumorIds.length === 0) return repoOk(applied("target-missing"));

    const targets = [...new Set(event.targetRumorIds)];
    const messagesQuery = store.evolu.createQuery((db) =>
      db
        .selectFrom("message")
        .selectAll()
        .where("rumorId", "in", targets.map(asParam)),
    );
    const messages = await store.evolu.loadQuery(messagesQuery);
    const reactions = await reactionsByRumorIds(targets);

    if (messages.length === 0 && reactions.length === 0) {
      return repoOk(applied("target-missing"));
    }

    // chat.delete: duplicate delete events must not double-apply — soft
    // deleting an already-deleted row is a no-op, reported as "duplicate".
    let appliedAny = false;
    for (const row of messages) {
      if (row.isDeleted === 1) continue;
      const result = store.update("message", { id: row.id, isDeleted: 1 });
      if (!result.ok) return validationErr(formatTypeError(result.error as never));
      appliedAny = true;
    }
    for (const row of reactions) {
      if (row.isDeleted === 1) continue;
      const result = store.update("reaction", { id: row.id, isDeleted: 1 });
      if (!result.ok) return validationErr(formatTypeError(result.error as never));
      appliedAny = true;
    }
    return repoOk(applied(appliedAny ? "applied" : "duplicate"));
  };

  return {
    applyChatEvent: async (event) => {
      const rumorId = NonEmptyString1000.fromUnknown(event.rumorId);
      if (!rumorId.ok) return validationErr("rumorId must be a non-empty string (max 1000)");

      // Inbox safety: drop every inbound event from a blocked sender before
      // touching any table — a block must prevent thread recreation.
      if (event.direction === "in" && (await isNpubBlocked(store, event.senderNpub))) {
        return repoOk(applied("blocked"));
      }

      switch (event.kind) {
        case "message":
          return applyMessage(event);
        case "edit":
          return applyEdit(event);
        case "reaction":
          return applyReaction(event);
        case "delete":
          return applyDelete(event);
      }
    },

    markSent: async (rumorId, wrapId) => {
      const existing = await messageByRumorId(rumorId);
      if (existing === null) return repoOk({ acknowledged: false });
      if (existing.status !== "pending" && wrapId === undefined) {
        return repoOk({ acknowledged: false });
      }
      const result = store.update("message", {
        id: existing.id,
        status: "sent",
        ...(wrapId === undefined ? {} : { wrapId }),
      });
      if (!result.ok) {
        return repoErr({
          _tag: "ChatEventValidationError" as const,
          reason: formatTypeError(result.error as never),
        });
      }
      return repoOk({ acknowledged: existing.status === "pending" });
    },

    getByRumorId: async (rumorId) => {
      const row = await messageByRumorId(rumorId);
      if (row === null || row.isDeleted === 1) return null;
      return toMessageRecord(row);
    },

    listPage: async ({ peerNpub, limit, cursor }) => {
      const query = store.evolu.createQuery((db) => {
        let q = db
          .selectFrom("message")
          .selectAll()
          .where("isDeleted", "is not", 1)
          .where("peerNpub", "=", asParam(peerNpub));
        if (cursor !== undefined) {
          // Strictly older than the cursor position: (sentAtSec, id) <
          // (cursor.sentAtSec, cursor.id) in the newest-first ordering.
          q = q.where((eb) =>
            eb.or([
              eb("sentAtSec", "<", asParam(cursor.sentAtSec)),
              eb.and([
                eb("sentAtSec", "=", asParam(cursor.sentAtSec)),
                eb("id", "<", asParam(cursor.id)),
              ]),
            ]),
          );
        }
        return q.orderBy("sentAtSec", "desc").orderBy("id", "desc").limit(limit);
      });
      const rows = await store.evolu.loadQuery(query);
      const items = rows.map(toMessageRecord);
      const last = items.at(-1);
      const nextCursor =
        items.length === limit && last !== undefined
          ? { sentAtSec: last.sentAtSec, id: last.id }
          : null;
      return { items, nextCursor };
    },

    latestReactions: async (messageRumorId) => {
      const query = store.evolu.createQuery((db) =>
        db
          .selectFrom("reaction")
          .selectAll()
          .where("isDeleted", "is not", 1)
          .where("messageRumorId", "=", asParam(messageRumorId)),
      );
      const rows = await store.evolu.loadQuery(query);
      // chat.react: one visible reaction per person — the latest one.
      // Deterministic tie-break on rumorId for identical timestamps.
      const latestByReactor = new Map<string, (typeof rows)[number]>();
      for (const row of rows) {
        const reactor = String(row.reactorNpub);
        const current = latestByReactor.get(reactor);
        if (
          current === undefined ||
          Number(row.sentAtSec) > Number(current.sentAtSec) ||
          (Number(row.sentAtSec) === Number(current.sentAtSec) &&
            String(row.rumorId) > String(current.rumorId))
        ) {
          latestByReactor.set(reactor, row);
        }
      }
      return [...latestByReactor.values()]
        .map(
          (row): ReactionRecord => ({
            id: String(row.id),
            rumorId: String(row.rumorId),
            messageRumorId: String(row.messageRumorId),
            reactorNpub: String(row.reactorNpub),
            emoji: String(row.emoji),
            sentAtSec: Number(row.sentAtSec),
            status: toStatus(row.status),
          }),
        )
        .sort((a, b) => a.sentAtSec - b.sentAtSec || (a.rumorId < b.rumorId ? -1 : 1));
    },
  };
};
