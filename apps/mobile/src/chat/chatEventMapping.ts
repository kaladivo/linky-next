/**
 * chatEventMapping — the #22 → #25 glue: converts a validated `ChatEvent`
 * from the NIP-17 engine (hex pubkeys) into the `ChatEventInput` the
 * `MessagesRepository` persists (npub-keyed conversations). Issue #29.
 *
 * Mapping rules (engine contract, see packages/core chatEvents.ts):
 *
 * - `direction`: "out" when the authenticated sender is the active identity
 *   (covers optimistic-echo self wraps from our own devices), else "in".
 * - Conversation peer:
 *   - inbound → the sender;
 *   - outbound message/edit → the first `p`-tagged pubkey that isn't us
 *     (the PoC tags [recipient, sender]);
 *   - outbound reaction/deletion → the engine's ChatEvent carries no peer
 *     tags, so the peer is resolved from the TARGET message already in
 *     storage (`lookupPeerNpub`); falls back to our own npub (the repo
 *     ignores `peerNpub` for reactions/deletes anyway — it only keys
 *     messages by it).
 * - Events whose pubkeys cannot be npub-encoded are dropped (`null`) —
 *   cannot happen for engine-validated events, defensive only.
 */
import type { ChatEvent } from "@linky/core";
import { publicKeyHexToNpub } from "@linky/core";
import type { ChatEventInput } from "@linky/evolu-store";

export interface OwnChatIdentity {
  /** The active identity's 64-char hex pubkey. */
  readonly publicKeyHex: string;
  /** The active identity's npub (same key, NIP-19 form). */
  readonly npub: string;
}

/** Resolves the conversation peer npub of a stored message rumor id. */
export type PeerNpubLookup = (targetRumorId: string) => Promise<string | null>;

/** "out" = authored by the active identity (send echo or other device). */
export const chatEventDirection = (event: ChatEvent, own: OwnChatIdentity): "in" | "out" =>
  event.senderPubkey === own.publicKeyHex ? "out" : "in";

/** The peer pubkey hex of a message/edit rumor, given its `p` tags. */
export const peerPubkeyHexFromTags = (
  taggedPubkeys: ReadonlyArray<string>,
  senderPubkey: string,
  own: OwnChatIdentity,
): string => {
  if (senderPubkey !== own.publicKeyHex) return senderPubkey;
  return taggedPubkeys.find((pubkey) => pubkey !== own.publicKeyHex) ?? own.publicKeyHex;
};

/**
 * Converts one engine event into its storage input. `null` = unmappable
 * (defensive; engine-validated pubkeys always npub-encode).
 */
export const toChatEventInput = async (
  event: ChatEvent,
  wrapId: string,
  own: OwnChatIdentity,
  lookupPeerNpub: PeerNpubLookup,
): Promise<ChatEventInput | null> => {
  const senderNpub = publicKeyHexToNpub(event.senderPubkey);
  if (senderNpub === null) return null;
  const direction = chatEventDirection(event, own);

  const base = {
    rumorId: event.rumorId,
    senderNpub,
    direction,
    sentAtSec: event.createdAtSec,
    wrapId,
  };

  switch (event._tag) {
    case "ChatMessage": {
      const peerNpub =
        direction === "in"
          ? senderNpub
          : publicKeyHexToNpub(
              peerPubkeyHexFromTags(event.taggedPubkeys, event.senderPubkey, own),
            );
      if (peerNpub === null) return null;
      return {
        kind: "message",
        ...base,
        peerNpub,
        content: event.content,
        ...(event.replyToId === null ? {} : { replyToRumorId: event.replyToId }),
      };
    }
    case "ChatMessageEdit": {
      const peerNpub =
        direction === "in"
          ? senderNpub
          : publicKeyHexToNpub(
              peerPubkeyHexFromTags(event.taggedPubkeys, event.senderPubkey, own),
            );
      if (peerNpub === null) return null;
      return {
        kind: "edit",
        ...base,
        peerNpub,
        targetRumorId: event.editedFromId,
        content: event.content,
      };
    }
    case "ChatReaction": {
      const peerNpub =
        direction === "in"
          ? senderNpub
          : ((await lookupPeerNpub(event.messageRumorId)) ?? own.npub);
      return {
        kind: "reaction",
        ...base,
        peerNpub,
        targetRumorId: event.messageRumorId,
        emoji: event.emoji,
      };
    }
    case "ChatDeletion": {
      const firstTarget = event.targetRumorIds[0];
      const peerNpub =
        direction === "in"
          ? senderNpub
          : firstTarget === undefined
            ? own.npub
            : ((await lookupPeerNpub(firstTarget)) ?? own.npub);
      return {
        kind: "delete",
        ...base,
        peerNpub,
        targetRumorIds: event.targetRumorIds,
      };
    }
  }
};
