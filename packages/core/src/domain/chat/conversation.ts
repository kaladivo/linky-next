/**
 * Conversation reducer — pure, deterministic application of {@link ChatEvent}s
 * to a conversation's state. Issue #22; consumed by storage (#25) and UI (#29).
 *
 * Design goals (stronger than the PoC's arrival-order-dependent hooks):
 *
 * - **Idempotent** — applying the same event twice never double-applies
 *   (`chat.delete` contract: duplicate deletions are no-ops; duplicate
 *   messages/reactions/edits likewise).
 * - **Order-independent** — any permutation of the same event set converges
 *   to the same state. Concretely:
 *   - an edit arriving before its original creates the message under the
 *     ORIGINAL rumor id with the edited content; the original later
 *     backfills `originalContent` + its own metadata (the PoC does the
 *     first half; the backfill here also restores `createdAtSec`/reply
 *     context so both orders converge);
 *   - competing edits resolve by latest `createdAtSec` (ties by rumor id);
 *   - a deletion arriving before its target suppresses the target when it
 *     arrives (sender-checked, see below).
 * - **Owner-checked deletes** — a deletion only affects messages/reactions
 *   authored by the deletion's sender (NIP-09 hygiene; the PoC trusts the
 *   ids, we don't). Deleted messages become tombstones (`isDeleted`),
 *   deleted reactions are removed.
 * - **Edit history** — the first content of an edited message is preserved
 *   in `originalContent` (`chat.edit-message`: original preserved locally).
 * - **Reactions** — every reaction is kept keyed by its rumor id;
 *   {@link aggregateReactions} surfaces the LATEST reaction per reactor per
 *   message (`chat.react`: one visible reaction per user). Reactions to
 *   not-yet-seen messages are retained (they attach when the message
 *   arrives — unlike the PoC, which drops them).
 *
 * Conversation attribution (which contact a message belongs to) is the
 * storage layer's job — this reducer models ONE conversation's events.
 */
import type { ChatDeletion, ChatEvent, ChatMessage, ChatMessageEdit, ChatReaction } from "./chatEvents.js";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export interface ConversationMessage {
  /** The ORIGINAL rumor id — stable across edits; the storage key. */
  readonly rumorId: string;
  readonly senderPubkey: string;
  readonly content: string;
  readonly createdAtSec: number;
  readonly clientTag: string | null;
  readonly replyToId: string | null;
  readonly rootMessageId: string | null;
  readonly isEdited: boolean;
  readonly editedAtSec: number | null;
  /** Rumor id of the applied edit (latest-wins tie-breaking). */
  readonly lastEditRumorId: string | null;
  /** First content of an edited message (null until known). */
  readonly originalContent: string | null;
  /** `false` while only an edit has been seen (original still in flight). */
  readonly originalSeen: boolean;
  /** Tombstone: deleted by its author via a kind-5 deletion. */
  readonly isDeleted: boolean;
}

export interface ConversationReaction {
  readonly rumorId: string;
  readonly messageRumorId: string;
  readonly reactorPubkey: string;
  readonly emoji: string;
  readonly createdAtSec: number;
  readonly clientTag: string | null;
}

export interface ConversationState {
  /** Messages keyed by original rumor id. */
  readonly messages: ReadonlyMap<string, ConversationMessage>;
  /** Reactions keyed by their own rumor id. */
  readonly reactions: ReadonlyMap<string, ConversationReaction>;
  /** Deletion targets ever seen: target rumor id → deletion senders. */
  readonly deletions: ReadonlyMap<string, ReadonlySet<string>>;
}

export const emptyConversationState: ConversationState = {
  messages: new Map(),
  reactions: new Map(),
  deletions: new Map(),
};

const isDeletedBy = (state: ConversationState, targetId: string, author: string): boolean =>
  state.deletions.get(targetId)?.has(author) ?? false;

// ---------------------------------------------------------------------------
// Event application
// ---------------------------------------------------------------------------

const applyMessage = (state: ConversationState, event: ChatMessage): ConversationState => {
  const existing = state.messages.get(event.rumorId);

  if (existing !== undefined) {
    // An edit got here first: backfill what only the original knows, so
    // edit-first and original-first arrival orders converge. The original's
    // author is authoritative (the verified rumor id hashes the pubkey): if
    // the synthesized author differs, the "edit" was forged — discard it by
    // falling through to a fresh insert below.
    if (!existing.originalSeen && existing.senderPubkey === event.senderPubkey) {
      const messages = new Map(state.messages);
      messages.set(event.rumorId, {
        ...existing,
        createdAtSec: event.createdAtSec,
        clientTag: existing.clientTag ?? event.clientTag,
        replyToId: event.replyToId,
        rootMessageId: event.rootMessageId,
        originalContent: event.content,
        originalSeen: true,
      });
      return { ...state, messages };
    }
    if (existing.originalSeen) return state; // duplicate
  }

  const messages = new Map(state.messages);
  messages.set(event.rumorId, {
    rumorId: event.rumorId,
    senderPubkey: event.senderPubkey,
    content: event.content,
    createdAtSec: event.createdAtSec,
    clientTag: event.clientTag,
    replyToId: event.replyToId,
    rootMessageId: event.rootMessageId,
    isEdited: false,
    editedAtSec: null,
    lastEditRumorId: null,
    originalContent: null,
    originalSeen: true,
    isDeleted: isDeletedBy(state, event.rumorId, event.senderPubkey),
  });
  return { ...state, messages };
};

/** Latest-wins ordering for edits: by time, ties by edit rumor id. */
const editSupersedes = (
  candidateAtSec: number,
  candidateRumorId: string,
  currentAtSec: number | null,
  currentRumorId: string | null,
): boolean => {
  if (currentAtSec === null || currentRumorId === null) return true;
  if (candidateAtSec !== currentAtSec) return candidateAtSec > currentAtSec;
  return candidateRumorId > currentRumorId;
};

const applyEdit = (state: ConversationState, event: ChatMessageEdit): ConversationState => {
  const target = state.messages.get(event.editedFromId);

  if (target === undefined) {
    // Edit before original: synthesize the message under the ORIGINAL rumor
    // id with the edited content (PoC behavior), original pending.
    const messages = new Map(state.messages);
    messages.set(event.editedFromId, {
      rumorId: event.editedFromId,
      senderPubkey: event.senderPubkey,
      content: event.content,
      createdAtSec: event.createdAtSec,
      clientTag: event.clientTag,
      replyToId: null,
      rootMessageId: null,
      isEdited: true,
      editedAtSec: event.createdAtSec,
      lastEditRumorId: event.rumorId,
      originalContent: null,
      originalSeen: false,
      isDeleted: isDeletedBy(state, event.editedFromId, event.senderPubkey),
    });
    return { ...state, messages };
  }

  // Only the author may edit their message. Edits still apply to deleted
  // messages (tombstones hide content anyway) so arrival order of
  // edit/deletion never changes the converged state.
  if (target.senderPubkey !== event.senderPubkey) return state;
  if (!editSupersedes(event.createdAtSec, event.rumorId, target.editedAtSec, target.lastEditRumorId)) {
    return state;
  }

  const messages = new Map(state.messages);
  messages.set(event.editedFromId, {
    ...target,
    content: event.content,
    isEdited: true,
    editedAtSec: event.createdAtSec,
    lastEditRumorId: event.rumorId,
    originalContent: target.isEdited ? target.originalContent : target.content,
  });
  return { ...state, messages };
};

const applyReaction = (state: ConversationState, event: ChatReaction): ConversationState => {
  if (state.reactions.has(event.rumorId)) return state; // duplicate
  // A deletion of this reaction by its own author already arrived.
  if (isDeletedBy(state, event.rumorId, event.senderPubkey)) return state;

  const reactions = new Map(state.reactions);
  reactions.set(event.rumorId, {
    rumorId: event.rumorId,
    messageRumorId: event.messageRumorId,
    reactorPubkey: event.senderPubkey,
    emoji: event.emoji,
    createdAtSec: event.createdAtSec,
    clientTag: event.clientTag,
  });
  return { ...state, reactions };
};

const applyDeletion = (state: ConversationState, event: ChatDeletion): ConversationState => {
  const deletions = new Map(state.deletions);
  let messages: Map<string, ConversationMessage> | null = null;
  let reactions: Map<string, ConversationReaction> | null = null;

  for (const targetId of event.targetRumorIds) {
    const senders = new Set(deletions.get(targetId) ?? []);
    senders.add(event.senderPubkey);
    deletions.set(targetId, senders);

    const reaction = state.reactions.get(targetId);
    if (reaction !== undefined && reaction.reactorPubkey === event.senderPubkey) {
      reactions ??= new Map(state.reactions);
      reactions.delete(targetId);
      continue;
    }

    const message = state.messages.get(targetId);
    if (message !== undefined && !message.isDeleted && message.senderPubkey === event.senderPubkey) {
      messages ??= new Map(state.messages);
      messages.set(targetId, { ...message, isDeleted: true });
    }
  }

  return {
    messages: messages ?? state.messages,
    reactions: reactions ?? state.reactions,
    deletions,
  };
};

/** Applies one validated chat event. Pure; returns the next state. */
export const applyChatEvent = (state: ConversationState, event: ChatEvent): ConversationState => {
  switch (event._tag) {
    case "ChatMessage":
      return applyMessage(state, event);
    case "ChatMessageEdit":
      return applyEdit(state, event);
    case "ChatReaction":
      return applyReaction(state, event);
    case "ChatDeletion":
      return applyDeletion(state, event);
  }
};

/** Folds a batch of events (e.g. an initial sync) into the state. */
export const applyChatEvents = (
  state: ConversationState,
  events: Iterable<ChatEvent>,
): ConversationState => {
  let next = state;
  for (const event of events) next = applyChatEvent(next, event);
  return next;
};

// ---------------------------------------------------------------------------
// Read models
// ---------------------------------------------------------------------------

/** Messages in deterministic display order (time, then rumor id). */
export const conversationMessages = (
  state: ConversationState,
): ReadonlyArray<ConversationMessage> =>
  [...state.messages.values()].sort(
    (a, b) => a.createdAtSec - b.createdAtSec || (a.rumorId < b.rumorId ? -1 : 1),
  );

export interface ChatReactionChip {
  readonly emoji: string;
  readonly count: number;
  readonly reactedByMe: boolean;
}

/**
 * `chat.react` read model: the latest reaction per reactor (by time, ties by
 * rumor id) for one message, bucketed by emoji, sorted by count then emoji.
 */
export const aggregateReactions = (
  state: ConversationState,
  messageRumorId: string,
  ownPubkeyHex: string | null,
): ReadonlyArray<ChatReactionChip> => {
  const latestByReactor = new Map<string, ConversationReaction>();
  for (const reaction of state.reactions.values()) {
    if (reaction.messageRumorId !== messageRumorId) continue;
    const current = latestByReactor.get(reaction.reactorPubkey);
    const supersedes =
      current === undefined ||
      reaction.createdAtSec > current.createdAtSec ||
      (reaction.createdAtSec === current.createdAtSec && reaction.rumorId > current.rumorId);
    if (supersedes) latestByReactor.set(reaction.reactorPubkey, reaction);
  }

  const buckets = new Map<string, { count: number; reactedByMe: boolean }>();
  for (const reaction of latestByReactor.values()) {
    const bucket = buckets.get(reaction.emoji) ?? { count: 0, reactedByMe: false };
    bucket.count += 1;
    if (ownPubkeyHex !== null && reaction.reactorPubkey === ownPubkeyHex) {
      bucket.reactedByMe = true;
    }
    buckets.set(reaction.emoji, bucket);
  }

  return [...buckets.entries()]
    .map(([emoji, bucket]) => ({ emoji, count: bucket.count, reactedByMe: bucket.reactedByMe }))
    .sort((a, b) => b.count - a.count || (a.emoji < b.emoji ? -1 : a.emoji > b.emoji ? 1 : 0));
};
