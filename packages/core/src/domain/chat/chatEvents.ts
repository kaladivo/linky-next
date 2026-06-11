/**
 * ChatEvent — the validated, typed output of the NIP-17 engine, and the
 * builders for outgoing rumors. Issue #22.
 *
 * A {@link ValidatedRumor} (authenticated sender, verified id) is classified
 * into the union the storage layer (#25) and UI (#29) consume:
 *
 * | rumor kind | tags (PoC wire format)                                  | ChatEvent          |
 * | ---------- | ------------------------------------------------------- | ------------------ |
 * | 14         | `p` recipient, `p` sender, `client`, `e` root/reply     | `ChatMessage`      |
 * | 14         | … + `edited_from` original-rumor-id                     | `ChatMessageEdit`  |
 * | 7          | `p`×3, `e` message-rumor-id, `k` "14", `client`         | `ChatReaction`     |
 * | 5          | `p`…, `e` target-rumor-id…, `client`                    | `ChatDeletion`     |
 *
 * Identity of everything is the RUMOR id: replies, reactions, edits and
 * deletions all reference rumor ids, and the rumor id is the storage dedupe
 * key. The PoC's `client` tag (a local id echoed back by the network copy)
 * is carried through as `clientTag` for `chat.pending-ack` reconciliation.
 *
 * Classification enforces the PoC's content rules: empty kind-14 content is
 * dropped, and content that still decrypts as a NIP-44 payload under any
 * plausible conversation key is rejected as `nested-encrypted-content`
 * (malformed double-encrypted events must never render as ciphertext).
 */
import { Either } from "effect";

import type { NostrEventTemplate } from "../nostr/NostrEvent.js";
import type { ValidatedRumor } from "./giftWrap.js";
import {
  CHAT_DELETION_KIND,
  CHAT_MESSAGE_KIND,
  CHAT_REACTION_KIND,
} from "./giftWrap.js";
import { getConversationKey, isDecryptableNip44Payload } from "./nip44.js";

// ---------------------------------------------------------------------------
// The ChatEvent union
// ---------------------------------------------------------------------------

interface ChatEventBase {
  /** Rumor id — THE message identity and dedupe key (contract for #25). */
  readonly rumorId: string;
  /** Authenticated sender (validated seal author). */
  readonly senderPubkey: string;
  /** The rumor's `created_at` (unix seconds) — the canonical event time. */
  readonly createdAtSec: number;
  /** The PoC's `client` tag, for optimistic-send reconciliation. */
  readonly clientTag: string | null;
}

/** A text message (kind 14 without `edited_from`). */
export interface ChatMessage extends ChatEventBase {
  readonly _tag: "ChatMessage";
  readonly content: string;
  /** `p`-tag values in order (recipient + sender mirror in the PoC). */
  readonly taggedPubkeys: ReadonlyArray<string>;
  /** NIP-10-style reply context (`e` tags with root/reply markers). */
  readonly replyToId: string | null;
  readonly rootMessageId: string | null;
}

/** An edit (kind 14 with `edited_from` pointing at the ORIGINAL rumor id). */
export interface ChatMessageEdit extends ChatEventBase {
  readonly _tag: "ChatMessageEdit";
  readonly content: string;
  readonly editedFromId: string;
  readonly taggedPubkeys: ReadonlyArray<string>;
}

/** A reaction (kind 7 targeting a message rumor id). */
export interface ChatReaction extends ChatEventBase {
  readonly _tag: "ChatReaction";
  readonly emoji: string;
  readonly messageRumorId: string;
}

/** A deletion (kind 5; targets are message or reaction rumor ids). */
export interface ChatDeletion extends ChatEventBase {
  readonly _tag: "ChatDeletion";
  readonly targetRumorIds: ReadonlyArray<string>;
}

export type ChatEvent = ChatMessage | ChatMessageEdit | ChatReaction | ChatDeletion;

// ---------------------------------------------------------------------------
// Tag extraction (PoC `chatNostrProtocol.ts` semantics)
// ---------------------------------------------------------------------------

type Tags = ReadonlyArray<ReadonlyArray<string>>;

const tagValue = (tag: ReadonlyArray<string>, index: number): string =>
  (tag[index] ?? "").trim();

/** First non-empty `client` tag value, or `null`. */
export const extractClientTag = (tags: Tags): string | null => {
  for (const tag of tags) {
    if (tag[0] !== "client") continue;
    const value = tagValue(tag, 1);
    if (value !== "") return value;
  }
  return null;
};

export interface ReplyContext {
  readonly replyToId: string | null;
  readonly rootMessageId: string | null;
}

/**
 * NIP-10-style reply context, exactly as the PoC reads it: explicit
 * `root`/`reply` markers win; otherwise the last of several `e` tags is the
 * reply, the first is the root; a single unmarked `e` tag is a root only.
 */
export const extractReplyContext = (tags: Tags): ReplyContext => {
  const eTags = tags.filter((tag) => tag[0] === "e");
  let rootMessageId: string | null = null;
  let replyToId: string | null = null;
  let firstId: string | null = null;
  let lastId: string | null = null;
  let eTagCount = 0;

  for (const tag of eTags) {
    const id = tagValue(tag, 1);
    if (id === "") continue;
    eTagCount += 1;
    firstId ??= id;
    lastId = id;
    const marker = tagValue(tag, 3).toLowerCase();
    if (marker === "root" && rootMessageId === null) rootMessageId = id;
    if (marker === "reply" && replyToId === null) replyToId = id;
  }

  if (replyToId === null && lastId !== null && eTagCount > 1) replyToId = lastId;
  if (rootMessageId === null && firstId !== null) rootMessageId = firstId;
  if (replyToId !== null && rootMessageId === null) rootMessageId = replyToId;
  if (replyToId === null && rootMessageId === null) return { replyToId: null, rootMessageId: null };
  return { replyToId, rootMessageId };
};

/** First non-empty `edited_from` tag value, or `null`. */
export const extractEditedFrom = (tags: Tags): string | null => {
  for (const tag of tags) {
    if (tag[0] !== "edited_from") continue;
    const value = tagValue(tag, 1);
    if (value !== "") return value;
  }
  return null;
};

/** Unique non-empty `e` tag values, in order (deletion targets). */
export const extractDeleteTargets = (tags: Tags): ReadonlyArray<string> => {
  const targets: Array<string> = [];
  const seen = new Set<string>();
  for (const tag of tags) {
    if (tag[0] !== "e") continue;
    const id = tagValue(tag, 1);
    if (id === "" || seen.has(id)) continue;
    seen.add(id);
    targets.push(id);
  }
  return targets;
};

const extractPubkeyTags = (tags: Tags): ReadonlyArray<string> => {
  const pubkeys: Array<string> = [];
  for (const tag of tags) {
    if (tag[0] !== "p") continue;
    const value = tagValue(tag, 1);
    if (value !== "") pubkeys.push(value);
  }
  return pubkeys;
};

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * Why a structurally valid, authenticated rumor still isn't a chat event:
 *
 * - `empty-content` — kind 14 with blank text / kind 7 with blank emoji.
 * - `nested-encrypted-content` — the content is itself a NIP-44 payload
 *   under one of the plausible conversation keys (PoC spoof/garbage rule).
 * - `missing-target` — kind 7/5 without an `e` tag.
 * - `wrong-target-kind` — kind 7 whose `k` tag targets something other
 *   than a chat message.
 * - `unsupported-kind` — any rumor kind the chat engine does not model.
 */
export type ChatRumorRejectionReason =
  | "empty-content"
  | "nested-encrypted-content"
  | "missing-target"
  | "wrong-target-kind"
  | "unsupported-kind";

export interface ChatRumorRejection {
  readonly _tag: "ChatRumorRejection";
  readonly wrapId: string;
  readonly rumorId: string;
  readonly reason: ChatRumorRejectionReason;
}

export interface ClassifyContext {
  /** Our active identity's secret key (for the nested-payload check). */
  readonly recipientSecretKey: Uint8Array;
  /** Our active identity's public key (to pick the "peer" `p` tag). */
  readonly recipientPublicKeyHex: string;
}

const rejectRumor = (
  validated: ValidatedRumor,
  reason: ChatRumorRejectionReason,
): Either.Either<ChatEvent, ChatRumorRejection> =>
  Either.left({
    _tag: "ChatRumorRejection",
    wrapId: validated.wrapId,
    rumorId: validated.rumor.id,
    reason,
  });

/**
 * The PoC's nested-payload spoof check: kind-14 content that decrypts as
 * NIP-44 under the conversation key with the rumor author, the tagged peer,
 * or the wrap signer is a double-encrypted/spoofed event, not text.
 */
const isNestedEncryptedContent = (
  content: string,
  candidates: ReadonlyArray<string>,
  recipientSecretKey: Uint8Array,
): boolean => {
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const pubkey = candidate.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(pubkey) || seen.has(pubkey)) continue;
    seen.add(pubkey);
    let conversationKey: Uint8Array;
    try {
      conversationKey = getConversationKey(recipientSecretKey, pubkey);
    } catch {
      continue;
    }
    if (isDecryptableNip44Payload(content, conversationKey)) return true;
  }
  return false;
};

/**
 * Classifies a validated rumor into a {@link ChatEvent}. Total: anything
 * unusable becomes a typed {@link ChatRumorRejection} (diagnostics only).
 */
export const classifyRumor = (
  validated: ValidatedRumor,
  context: ClassifyContext,
): Either.Either<ChatEvent, ChatRumorRejection> => {
  const { rumor } = validated;
  const base = {
    rumorId: rumor.id,
    senderPubkey: validated.senderPubkey,
    createdAtSec: rumor.created_at,
    clientTag: extractClientTag(rumor.tags),
  };

  switch (rumor.kind) {
    case CHAT_MESSAGE_KIND: {
      if (rumor.content.trim() === "") return rejectRumor(validated, "empty-content");

      const taggedPubkeys = extractPubkeyTags(rumor.tags);
      const taggedPeer =
        taggedPubkeys.find((pubkey) => pubkey !== context.recipientPublicKeyHex) ?? "";
      if (
        isNestedEncryptedContent(
          rumor.content,
          [rumor.pubkey, taggedPeer, validated.wrapPubkey],
          context.recipientSecretKey,
        )
      ) {
        return rejectRumor(validated, "nested-encrypted-content");
      }

      const editedFromId = extractEditedFrom(rumor.tags);
      if (editedFromId !== null) {
        return Either.right({
          _tag: "ChatMessageEdit",
          ...base,
          content: rumor.content,
          editedFromId,
          taggedPubkeys,
        });
      }

      const { replyToId, rootMessageId } = extractReplyContext(rumor.tags);
      return Either.right({
        _tag: "ChatMessage",
        ...base,
        content: rumor.content,
        taggedPubkeys,
        replyToId,
        rootMessageId,
      });
    }

    case CHAT_REACTION_KIND: {
      const targets = extractDeleteTargets(rumor.tags);
      const messageRumorId = targets[0];
      if (messageRumorId === undefined) return rejectRumor(validated, "missing-target");

      for (const tag of rumor.tags) {
        if (tag[0] !== "k") continue;
        const kindTag = tagValue(tag, 1);
        if (kindTag !== "" && kindTag !== String(CHAT_MESSAGE_KIND)) {
          return rejectRumor(validated, "wrong-target-kind");
        }
      }

      const emoji = rumor.content.trim();
      if (emoji === "") return rejectRumor(validated, "empty-content");
      return Either.right({ _tag: "ChatReaction", ...base, emoji, messageRumorId });
    }

    case CHAT_DELETION_KIND: {
      const targetRumorIds = extractDeleteTargets(rumor.tags);
      if (targetRumorIds.length === 0) return rejectRumor(validated, "missing-target");
      return Either.right({ _tag: "ChatDeletion", ...base, targetRumorIds });
    }

    default:
      return rejectRumor(validated, "unsupported-kind");
  }
};

// ---------------------------------------------------------------------------
// Outgoing rumor templates (PoC wire format)
// ---------------------------------------------------------------------------

const clientTagOf = (clientTag: string | undefined): ReadonlyArray<ReadonlyArray<string>> =>
  clientTag === undefined ? [] : [["client", clientTag]];

export interface ChatMessageTemplateInput {
  readonly senderPublicKeyHex: string;
  readonly recipientPublicKeyHex: string;
  readonly content: string;
  readonly createdAtSec: number;
  /** Local optimistic-send id, echoed back for `chat.pending-ack`. */
  readonly clientTag?: string;
  readonly reply?: {
    readonly replyToId: string;
    /** Defaults to `replyToId` (top-level replies), like the PoC. */
    readonly rootMessageId?: string;
  };
}

/** A kind-14 text message template (PoC tag layout, including reply markers). */
export const makeChatMessageTemplate = (input: ChatMessageTemplateInput): NostrEventTemplate => {
  const replyTags: Array<ReadonlyArray<string>> = [];
  if (input.reply !== undefined) {
    const rootId = input.reply.rootMessageId ?? input.reply.replyToId;
    replyTags.push(["e", rootId, "", "root"], ["e", input.reply.replyToId, "", "reply"]);
  }
  return {
    kind: CHAT_MESSAGE_KIND,
    created_at: input.createdAtSec,
    tags: [
      ["p", input.recipientPublicKeyHex],
      ["p", input.senderPublicKeyHex],
      ...clientTagOf(input.clientTag),
      ...replyTags,
    ],
    content: input.content,
  };
};

export interface ChatEditTemplateInput {
  readonly senderPublicKeyHex: string;
  readonly recipientPublicKeyHex: string;
  readonly content: string;
  readonly createdAtSec: number;
  /** The ORIGINAL message's rumor id (stable across repeated edits). */
  readonly editedFromId: string;
  readonly clientTag?: string;
}

/** A kind-14 edit template (`edited_from` tag, PoC mechanism). */
export const makeChatEditTemplate = (input: ChatEditTemplateInput): NostrEventTemplate => ({
  kind: CHAT_MESSAGE_KIND,
  created_at: input.createdAtSec,
  tags: [
    ["p", input.recipientPublicKeyHex],
    ["p", input.senderPublicKeyHex],
    ["edited_from", input.editedFromId],
    ...clientTagOf(input.clientTag),
  ],
  content: input.content,
});

export interface ChatReactionTemplateInput {
  readonly senderPublicKeyHex: string;
  readonly recipientPublicKeyHex: string;
  /** Author of the message being reacted to (PoC tags them too). */
  readonly messageAuthorPublicKeyHex: string;
  readonly messageRumorId: string;
  readonly emoji: string;
  readonly createdAtSec: number;
  readonly clientTag?: string;
}

/** A kind-7 reaction template (`e` message rumor id, `k` "14"). */
export const makeChatReactionTemplate = (input: ChatReactionTemplateInput): NostrEventTemplate => ({
  kind: CHAT_REACTION_KIND,
  created_at: input.createdAtSec,
  tags: [
    ["p", input.messageAuthorPublicKeyHex],
    ["p", input.recipientPublicKeyHex],
    ["p", input.senderPublicKeyHex],
    ["e", input.messageRumorId],
    ["k", String(CHAT_MESSAGE_KIND)],
    ...clientTagOf(input.clientTag),
  ],
  content: input.emoji,
});

export interface ChatDeletionTemplateInput {
  readonly senderPublicKeyHex: string;
  readonly recipientPublicKeyHex: string;
  /** Rumor ids of own messages/reactions to delete. */
  readonly targetRumorIds: ReadonlyArray<string>;
  readonly createdAtSec: number;
  /** Extra `p` tags (the PoC tags the target message's author). */
  readonly extraTaggedPubkeys?: ReadonlyArray<string>;
  readonly clientTag?: string;
}

/** A kind-5 deletion template (one `e` tag per target rumor id). */
export const makeChatDeletionTemplate = (input: ChatDeletionTemplateInput): NostrEventTemplate => ({
  kind: CHAT_DELETION_KIND,
  created_at: input.createdAtSec,
  tags: [
    ["p", input.recipientPublicKeyHex],
    ["p", input.senderPublicKeyHex],
    ...(input.extraTaggedPubkeys ?? []).map((pubkey) => ["p", pubkey]),
    ...input.targetRumorIds.map((id) => ["e", id]),
    ...clientTagOf(input.clientTag),
  ],
  content: "",
});
