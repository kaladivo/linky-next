/**
 * Chat actions (#29): send / edit / react / delete-chat for one
 * conversation. Storage first (optimistic), network second — PoC parity:
 *
 * - `chat.send-message`: the rumor id is computed BEFORE publish
 *   (deterministic NIP-01 hash of the unsigned rumor), the message row is
 *   written `status: "pending"`, then both gift wraps (recipient + self
 *   sync copy) go out via `deliverNostrEvent` (publish-with-retry, offline
 *   → persistent pending queue). On the first relay ACK the row is marked
 *   sent (`chat.pending-ack` fast path); if everything queued, the row
 *   stays pending until the flushed self wrap echoes back through the
 *   inbox (slow path) — never duplicated, because the echo carries the
 *   same rumor id.
 * - `chat.edit-message`: kind-14 with `edited_from` = ORIGINAL rumor id
 *   (stable across repeated edits, PoC mechanism). Applied locally through
 *   the same `applyChatEvent` path the inbox uses (history preserved).
 * - `chat.react`: PoC toggle — delete ALL my previous reaction events on
 *   the message (kind 5), then send the new reaction unless it was a
 *   toggle-off (same emoji).
 * - Delete chat: LOCAL-ONLY (account-local). Soft-deletes every
 *   message/reaction row of the conversation; tombstones sync to the
 *   user's own devices on the messages lane, and storage-side rumor-id
 *   dedup keeps re-arriving wraps from resurrecting anything. No Nostr
 *   event is sent — the peer keeps their copy (standard messenger
 *   "delete chat for me"). For unknown threads the local thread row is
 *   removed too; a NEW inbound message recreates the thread.
 *
 * Like contactThreadActions: plain async, screens see plain results; only
 * the Nostr work runs as Effects on the app runtime.
 */
import {
  createChatGiftWraps,
  createRumor,
  deliverNostrEvent,
  loadSession,
  makeChatDeletionTemplate,
  makeChatEditTemplate,
  makeChatMessageTemplate,
  makeChatReactionTemplate,
  npubToPublicKeyHex,
} from "@linky/core";
import type { NostrEventTemplate, NostrIdentity } from "@linky/core";
import {
  createMessagesRepository,
  createUnknownThreadsRepository,
} from "@linky/evolu-store";
import type { LinkyStore, MessageRecord, ReactionRecord } from "@linky/evolu-store";
import { Effect } from "effect";

import { runAppEffect } from "../runtime";
import { invalidateStoreData } from "../store/storeManager";
import { planReactionToggle } from "./conversationModel";

export const nowSec = (): number => Math.ceil(Date.now() / 1000);

/** PoC `makeLocalId` equivalent: a short unique local id for `client` tags. */
export const makeClientTag = (): string =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/** The active identity, or null when no session is loaded (defensive). */
const activeIdentity = async (): Promise<NostrIdentity | null> => {
  try {
    const session = await runAppEffect(loadSession);
    return session._tag === "IdentityLoaded" ? session.session.activeNostr.identity : null;
  } catch {
    return null;
  }
};

/**
 * Wraps + delivers one rumor template to the peer and to ourselves (sync
 * copy). Resolves with how it left the device; never throws — a total
 * failure resolves "failed" (the persistent queue path itself failing).
 * Shared with the chat-payment send path (#44, chatPayActions.ts).
 */
export const publishChatTemplate = async (
  template: NostrEventTemplate,
  sender: NostrIdentity,
  recipientPublicKeyHex: string,
  options: { readonly pushMarker: boolean },
): Promise<{ readonly outcome: "accepted" | "queued" | "failed"; readonly selfWrapId: string | null }> => {
  try {
    return await runAppEffect(
      Effect.gen(function* () {
        const wraps = yield* createChatGiftWraps(
          template,
          { secretKey: sender.secretKey, publicKeyHex: sender.publicKeyHex },
          recipientPublicKeyHex,
          { pushMarkerForRecipient: options.pushMarker },
        );
        const toRecipient = yield* deliverNostrEvent(wraps.wrapForRecipient);
        const toSelf = yield* deliverNostrEvent(wraps.wrapForSender);
        const accepted = toRecipient.outcome === "accepted" || toSelf.outcome === "accepted";
        return {
          outcome: accepted ? ("accepted" as const) : ("queued" as const),
          selfWrapId: wraps.wrapForSender.id,
        };
      }),
    );
  } catch (error) {
    if (__DEV__) console.warn("[chat] publish failed:", error);
    return { outcome: "failed", selfWrapId: null };
  }
};

// ─── chat.send-message ───────────────────────────────────────────────────

export interface ReplyContext {
  readonly replyToId: string;
  /** Defaults to `replyToId` (top-level replies), like the PoC. */
  readonly rootMessageId?: string;
}

export type SendMessageResult =
  | { readonly outcome: "sent"; readonly rumorId: string }
  | { readonly outcome: "failed"; readonly reason: "no-session" | "bad-peer" | "empty" | "store" };

/**
 * Sends a text message: optimistic pending row first, network second. The
 * returned promise settles after the OPTIMISTIC write (the screen updates
 * immediately); delivery continues in the background and flips the row to
 * "sent" via `markSent` or the inbox echo.
 */
export const sendChatMessage = async (
  store: LinkyStore,
  peerNpub: string,
  text: string,
  reply?: ReplyContext,
): Promise<SendMessageResult> => {
  const content = text.trim();
  if (content === "") return { outcome: "failed", reason: "empty" };
  const sender = await activeIdentity();
  if (sender === null) return { outcome: "failed", reason: "no-session" };
  const peerHex = npubToPublicKeyHex(peerNpub);
  if (peerHex === null) return { outcome: "failed", reason: "bad-peer" };

  const template = makeChatMessageTemplate({
    senderPublicKeyHex: sender.publicKeyHex,
    recipientPublicKeyHex: peerHex,
    content,
    createdAtSec: nowSec(),
    clientTag: makeClientTag(),
    ...(reply === undefined ? {} : { reply }),
  });
  const rumor = createRumor(template, sender.publicKeyHex);

  const messages = createMessagesRepository(store);
  const applied = await messages.applyChatEvent({
    kind: "message",
    rumorId: rumor.id,
    peerNpub,
    senderNpub: sender.npub,
    direction: "out",
    content,
    sentAtSec: rumor.created_at,
    status: "pending",
    ...(reply === undefined ? {} : { replyToRumorId: reply.replyToId }),
  });
  if (!applied.ok) return { outcome: "failed", reason: "store" };
  invalidateStoreData();

  // Fire-and-forget delivery; the pending row reconciles via markSent (fast
  // path) or the inbox echo (queued path).
  void publishChatTemplate(template, sender, peerHex, { pushMarker: true }).then(
    async ({ outcome, selfWrapId }) => {
      if (outcome !== "accepted") return;
      await messages.markSent(rumor.id, selfWrapId ?? undefined);
      invalidateStoreData();
    },
  );

  return { outcome: "sent", rumorId: rumor.id };
};

// ─── chat.edit-message ───────────────────────────────────────────────────

export type EditMessageResult =
  | { readonly outcome: "edited" }
  | { readonly outcome: "failed"; readonly reason: "no-session" | "bad-peer" | "empty" | "store" };

/** Edits an OWN message (`edited_from` = the original's stable rumor id). */
export const editChatMessage = async (
  store: LinkyStore,
  peerNpub: string,
  original: MessageRecord,
  newText: string,
): Promise<EditMessageResult> => {
  const content = newText.trim();
  if (content === "") return { outcome: "failed", reason: "empty" };
  const sender = await activeIdentity();
  if (sender === null) return { outcome: "failed", reason: "no-session" };
  const peerHex = npubToPublicKeyHex(peerNpub);
  if (peerHex === null) return { outcome: "failed", reason: "bad-peer" };

  const template = makeChatEditTemplate({
    senderPublicKeyHex: sender.publicKeyHex,
    recipientPublicKeyHex: peerHex,
    content,
    createdAtSec: nowSec(),
    editedFromId: original.rumorId,
    clientTag: makeClientTag(),
  });
  const rumor = createRumor(template, sender.publicKeyHex);

  const messages = createMessagesRepository(store);
  const applied = await messages.applyChatEvent({
    kind: "edit",
    rumorId: rumor.id,
    peerNpub,
    senderNpub: sender.npub,
    direction: "out",
    targetRumorId: original.rumorId,
    content,
    sentAtSec: rumor.created_at,
  });
  if (!applied.ok) return { outcome: "failed", reason: "store" };
  invalidateStoreData();

  void publishChatTemplate(template, sender, peerHex, { pushMarker: false });
  return { outcome: "edited" };
};

// ─── chat.react ──────────────────────────────────────────────────────────

export type ToggleReactionResult =
  | { readonly outcome: "reacted" | "removed" }
  | { readonly outcome: "failed"; readonly reason: "no-session" | "bad-peer" | "store" };

/**
 * PoC reaction toggle: deletes ALL my reaction events on the message
 * (kind 5 targeting their rumor ids), then sends the new reaction unless
 * the same emoji was tapped (toggle-off). `myReactions` comes from the
 * loaded conversation (all active rows of mine on this message).
 */
export const toggleReaction = async (
  store: LinkyStore,
  peerNpub: string,
  message: MessageRecord,
  myReactions: ReadonlyArray<ReactionRecord>,
  emoji: string,
): Promise<ToggleReactionResult> => {
  const sender = await activeIdentity();
  if (sender === null) return { outcome: "failed", reason: "no-session" };
  const peerHex = npubToPublicKeyHex(peerNpub);
  if (peerHex === null) return { outcome: "failed", reason: "bad-peer" };
  const messageAuthorHex =
    (message.senderNpub !== null ? npubToPublicKeyHex(message.senderNpub) : null) ?? peerHex;

  const plan = planReactionToggle(myReactions, emoji);
  const messages = createMessagesRepository(store);

  if (plan.deleteRumorIds.length > 0) {
    const deleteTemplate = makeChatDeletionTemplate({
      senderPublicKeyHex: sender.publicKeyHex,
      recipientPublicKeyHex: peerHex,
      targetRumorIds: plan.deleteRumorIds,
      createdAtSec: nowSec(),
      extraTaggedPubkeys: [messageAuthorHex],
      clientTag: makeClientTag(),
    });
    const deleteRumor = createRumor(deleteTemplate, sender.publicKeyHex);
    const applied = await messages.applyChatEvent({
      kind: "delete",
      rumorId: deleteRumor.id,
      peerNpub,
      senderNpub: sender.npub,
      direction: "out",
      targetRumorIds: plan.deleteRumorIds,
      sentAtSec: deleteRumor.created_at,
    });
    if (!applied.ok) return { outcome: "failed", reason: "store" };
    void publishChatTemplate(deleteTemplate, sender, peerHex, { pushMarker: false });
  }

  if (plan.sendEmoji === null) {
    invalidateStoreData();
    return { outcome: "removed" };
  }

  const reactionTemplate = makeChatReactionTemplate({
    senderPublicKeyHex: sender.publicKeyHex,
    recipientPublicKeyHex: peerHex,
    messageAuthorPublicKeyHex: messageAuthorHex,
    messageRumorId: message.rumorId,
    emoji: plan.sendEmoji,
    createdAtSec: nowSec(),
    clientTag: makeClientTag(),
  });
  const reactionRumor = createRumor(reactionTemplate, sender.publicKeyHex);
  const applied = await messages.applyChatEvent({
    kind: "reaction",
    rumorId: reactionRumor.id,
    peerNpub,
    senderNpub: sender.npub,
    direction: "out",
    targetRumorId: message.rumorId,
    emoji: plan.sendEmoji,
    sentAtSec: reactionRumor.created_at,
  });
  if (!applied.ok) return { outcome: "failed", reason: "store" };
  invalidateStoreData();

  void publishChatTemplate(reactionTemplate, sender, peerHex, { pushMarker: false });
  return { outcome: "reacted" };
};

// ─── Delete chat (local-only) ────────────────────────────────────────────

export type DeleteChatResult =
  | { readonly outcome: "deleted"; readonly deletedMessages: number }
  | { readonly outcome: "failed" };

/**
 * Deletes the whole conversation with `peerNpub` from this account:
 * soft-deletes all message/reaction rows (tombstones sync to own devices)
 * and removes the local unknown-thread row when one exists. No Nostr
 * event is sent — see the module doc for the chosen semantics.
 */
export const deleteChat = async (
  store: LinkyStore,
  peerNpub: string,
): Promise<DeleteChatResult> => {
  const messages = createMessagesRepository(store);
  const threads = createUnknownThreadsRepository(store);

  const result = await messages.deleteConversation(peerNpub);
  if (!result.ok) return { outcome: "failed" };
  await threads.remove(peerNpub);
  invalidateStoreData();
  return { outcome: "deleted", deletedMessages: result.value.deletedMessages };
};
