/**
 * conversationModel — pure view-model logic for the chat screen (#29).
 * No React, no Evolu: takes repository records and produces render models.
 *
 * PoC-pinned semantics:
 *
 * - `chat.react`: ONE visible reaction per person — the latest reaction
 *   event per reactor (ties broken by rumor id), bucketed into emoji chips
 *   sorted by count then emoji (PoC `aggregateReactions`).
 * - Reaction toggle (PoC `useSendReaction`): tapping an emoji deletes ALL
 *   of my reaction events on that message; if any of them already carried
 *   the same emoji it is a toggle-OFF (nothing new is sent), otherwise a
 *   new reaction with the tapped emoji follows.
 * - Reply previews quote the referenced message's CURRENT content
 *   (single line, truncated); a missing/deleted target renders the
 *   localized "original unavailable" fallback (handled by the screen).
 */
import type { MessageRecord, ReactionRecord } from "@linky/evolu-store";

// ─── Reactions (chat.react) ──────────────────────────────────────────────

export interface ReactionChip {
  readonly emoji: string;
  readonly count: number;
  readonly reactedByMe: boolean;
}

const supersedes = (candidate: ReactionRecord, current: ReactionRecord | undefined): boolean =>
  current === undefined ||
  candidate.sentAtSec > current.sentAtSec ||
  (candidate.sentAtSec === current.sentAtSec && candidate.rumorId > current.rumorId);

/** The latest reaction per reactor for ONE message's reactions. */
export const latestReactionPerPerson = (
  reactions: ReadonlyArray<ReactionRecord>,
): ReadonlyArray<ReactionRecord> => {
  const latestByReactor = new Map<string, ReactionRecord>();
  for (const reaction of reactions) {
    if (supersedes(reaction, latestByReactor.get(reaction.reactorNpub))) {
      latestByReactor.set(reaction.reactorNpub, reaction);
    }
  }
  return [...latestByReactor.values()];
};

/**
 * Emoji chips for every message in one pass: latest-per-person reduced,
 * bucketed by emoji, sorted by count desc then emoji (PoC order).
 */
export const reactionChipsByMessage = (
  reactions: ReadonlyArray<ReactionRecord>,
  ownNpub: string | null,
): ReadonlyMap<string, ReadonlyArray<ReactionChip>> => {
  const byMessage = new Map<string, ReactionRecord[]>();
  for (const reaction of reactions) {
    const list = byMessage.get(reaction.messageRumorId) ?? [];
    list.push(reaction);
    byMessage.set(reaction.messageRumorId, list);
  }

  const chips = new Map<string, ReadonlyArray<ReactionChip>>();
  for (const [messageRumorId, list] of byMessage) {
    const buckets = new Map<string, { count: number; reactedByMe: boolean }>();
    for (const reaction of latestReactionPerPerson(list)) {
      const bucket = buckets.get(reaction.emoji) ?? { count: 0, reactedByMe: false };
      bucket.count += 1;
      if (ownNpub !== null && reaction.reactorNpub === ownNpub) bucket.reactedByMe = true;
      buckets.set(reaction.emoji, bucket);
    }
    chips.set(
      messageRumorId,
      [...buckets.entries()]
        .map(([emoji, bucket]) => ({ emoji, ...bucket }))
        .sort((a, b) => b.count - a.count || (a.emoji < b.emoji ? -1 : a.emoji > b.emoji ? 1 : 0)),
    );
  }
  return chips;
};

/** ALL of my active reaction events on a message (toggle deletes them all). */
export const myReactionsOnMessage = (
  reactions: ReadonlyArray<ReactionRecord>,
  messageRumorId: string,
  ownNpub: string,
): ReadonlyArray<ReactionRecord> =>
  reactions.filter(
    (reaction) => reaction.messageRumorId === messageRumorId && reaction.reactorNpub === ownNpub,
  );

export interface ReactionTogglePlan {
  /** My reaction rumor ids to delete (kind 5) before anything new. */
  readonly deleteRumorIds: ReadonlyArray<string>;
  /** The reaction to send afterwards; null = pure toggle-off. */
  readonly sendEmoji: string | null;
}

/** PoC toggle semantics: same emoji anywhere in mine → off; else replace. */
export const planReactionToggle = (
  myReactions: ReadonlyArray<ReactionRecord>,
  emoji: string,
): ReactionTogglePlan => {
  const deleteRumorIds = myReactions.map((reaction) => reaction.rumorId);
  const hasSameEmoji = myReactions.some((reaction) => reaction.emoji === emoji);
  return { deleteRumorIds, sendEmoji: hasSameEmoji ? null : emoji };
};

// ─── Reply previews (chat.reply) ─────────────────────────────────────────

const REPLY_PREVIEW_MAX_CHARS = 90;

/** Single-line, truncated quote of a replied-to message's content. */
export const replyPreviewText = (content: string): string => {
  const singleLine = content.replace(/\s+/g, " ").trim();
  return singleLine.length <= REPLY_PREVIEW_MAX_CHARS
    ? singleLine
    : `${singleLine.slice(0, REPLY_PREVIEW_MAX_CHARS - 1)}…`;
};

/**
 * Reply targets that are NOT in the loaded window and need a storage
 * lookup (off-page or deleted originals).
 */
export const missingReplyTargets = (
  messages: ReadonlyArray<MessageRecord>,
): ReadonlyArray<string> => {
  const loaded = new Set(messages.map((message) => message.rumorId));
  const missing = new Set<string>();
  for (const message of messages) {
    if (message.replyToRumorId !== null && !loaded.has(message.replyToRumorId)) {
      missing.add(message.replyToRumorId);
    }
  }
  return [...missing];
};
