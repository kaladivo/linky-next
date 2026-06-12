/**
 * chatEventMapping (#29): engine ChatEvent (hex pubkeys) → storage
 * ChatEventInput (npub conversations). Pubkey fixtures are the committed
 * dev identities (dev/test-identities/{alice,bob}.json).
 */
import { describe, expect, it } from "vitest";

import type { ChatEvent } from "@linky/core";

import { chatEventDirection, peerPubkeyHexFromTags, toChatEventInput } from "./chatEventMapping";

const ALICE_HEX = "1af20e896eca5cefb89c0d866d3a1bbd8ddd4413b615689c9c61513043966b7c";
const ALICE_NPUB = "npub1rteqaztwefwwlwyupkrx6wsmhkxa63qnkc2k38yuv9gnqsukdd7qw8qw9d";
const BOB_HEX = "83beffec065f05ea4b58bb4050c7f358283e27c5556874ddab279dfdd6cef670";
const BOB_NPUB = "npub1swl0lmqxtuz75j6chdq9p3lntq5ruf792458fhdty7wlm4kw7ecq47mgja";

/** Tests run as Alice. */
const own = { publicKeyHex: ALICE_HEX, npub: ALICE_NPUB };

const noLookup = () => Promise.resolve<string | null>(null);

const message = (overrides: Partial<Extract<ChatEvent, { _tag: "ChatMessage" }>> = {}): ChatEvent => ({
  _tag: "ChatMessage",
  rumorId: "rumor-1",
  senderPubkey: BOB_HEX,
  createdAtSec: 1_750_000_000,
  clientTag: null,
  content: "hello",
  taggedPubkeys: [ALICE_HEX, BOB_HEX],
  replyToId: null,
  rootMessageId: null,
  ...overrides,
});

describe("chatEventDirection / peerPubkeyHexFromTags", () => {
  it("derives direction from the authenticated sender", () => {
    expect(chatEventDirection(message(), own)).toBe("in");
    expect(chatEventDirection(message({ senderPubkey: ALICE_HEX }), own)).toBe("out");
  });

  it("derives the peer from p tags for own events, sender otherwise", () => {
    expect(peerPubkeyHexFromTags([BOB_HEX, ALICE_HEX], ALICE_HEX, own)).toBe(BOB_HEX);
    expect(peerPubkeyHexFromTags([ALICE_HEX, BOB_HEX], BOB_HEX, own)).toBe(BOB_HEX);
    // Self-DM degenerate case: stays on our own conversation.
    expect(peerPubkeyHexFromTags([ALICE_HEX], ALICE_HEX, own)).toBe(ALICE_HEX);
  });
});

describe("toChatEventInput", () => {
  it("maps an inbound message (peer = sender)", async () => {
    const input = await toChatEventInput(
      message({ replyToId: "rumor-0", rootMessageId: "rumor-0" }),
      "wrap-1",
      own,
      noLookup,
    );
    expect(input).toEqual({
      kind: "message",
      rumorId: "rumor-1",
      senderNpub: BOB_NPUB,
      peerNpub: BOB_NPUB,
      direction: "in",
      sentAtSec: 1_750_000_000,
      wrapId: "wrap-1",
      content: "hello",
      replyToRumorId: "rumor-0",
    });
  });

  it("maps an own-message echo (peer = tagged recipient)", async () => {
    const input = await toChatEventInput(
      message({ senderPubkey: ALICE_HEX, taggedPubkeys: [BOB_HEX, ALICE_HEX] }),
      "wrap-2",
      own,
      noLookup,
    );
    expect(input?.kind).toBe("message");
    expect(input?.direction).toBe("out");
    expect(input?.peerNpub).toBe(BOB_NPUB);
    expect(input?.senderNpub).toBe(ALICE_NPUB);
  });

  it("maps an edit to its target rumor id", async () => {
    const input = await toChatEventInput(
      {
        _tag: "ChatMessageEdit",
        rumorId: "edit-1",
        senderPubkey: BOB_HEX,
        createdAtSec: 1_750_000_100,
        clientTag: "c1",
        content: "fixed",
        editedFromId: "rumor-1",
        taggedPubkeys: [ALICE_HEX, BOB_HEX],
      },
      "wrap-3",
      own,
      noLookup,
    );
    expect(input).toMatchObject({
      kind: "edit",
      rumorId: "edit-1",
      targetRumorId: "rumor-1",
      content: "fixed",
      direction: "in",
      peerNpub: BOB_NPUB,
    });
  });

  it("maps reactions, resolving the peer of own echoes from storage", async () => {
    const inbound = await toChatEventInput(
      {
        _tag: "ChatReaction",
        rumorId: "react-1",
        senderPubkey: BOB_HEX,
        createdAtSec: 1_750_000_200,
        clientTag: null,
        emoji: "❤️",
        messageRumorId: "rumor-1",
      },
      "wrap-4",
      own,
      noLookup,
    );
    expect(inbound).toMatchObject({ kind: "reaction", peerNpub: BOB_NPUB, direction: "in" });

    const echo = await toChatEventInput(
      {
        _tag: "ChatReaction",
        rumorId: "react-2",
        senderPubkey: ALICE_HEX,
        createdAtSec: 1_750_000_300,
        clientTag: null,
        emoji: "👍",
        messageRumorId: "rumor-1",
      },
      "wrap-5",
      own,
      (target) => Promise.resolve(target === "rumor-1" ? BOB_NPUB : null),
    );
    expect(echo).toMatchObject({ kind: "reaction", peerNpub: BOB_NPUB, direction: "out" });
  });

  it("maps deletions with all targets", async () => {
    const input = await toChatEventInput(
      {
        _tag: "ChatDeletion",
        rumorId: "del-1",
        senderPubkey: ALICE_HEX,
        createdAtSec: 1_750_000_400,
        clientTag: null,
        targetRumorIds: ["react-2", "react-9"],
      },
      "wrap-6",
      own,
      (target) => Promise.resolve(target === "react-2" ? BOB_NPUB : null),
    );
    expect(input).toMatchObject({
      kind: "delete",
      direction: "out",
      targetRumorIds: ["react-2", "react-9"],
      peerNpub: BOB_NPUB,
    });
  });
});
