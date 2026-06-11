/**
 * ChatEvent classification + outgoing template builders (issue #22).
 * PoC-shape parity for tags, and the validation rules the engine enforces
 * on top of unwrap (empty/nested content, targets, kinds).
 */
import { Either } from "effect";
import { describe, expect, it } from "vitest";

import type { NostrEventTemplate } from "../nostr/NostrEvent.js";
import type { ChatEvent, ChatRumorRejectionReason } from "./chatEvents.js";
import {
  classifyRumor,
  extractReplyContext,
  makeChatDeletionTemplate,
  makeChatEditTemplate,
  makeChatMessageTemplate,
  makeChatReactionTemplate,
} from "./chatEvents.js";
import { alice, bob } from "./chatTestKit.js";
import type { ValidatedRumor } from "./giftWrap.js";
import { createRumor } from "./giftWrap.js";
import { encryptNip44, getConversationKey } from "./nip44.js";

const AT = 1_750_000_000;
const WRAP_PUBKEY = "ab".repeat(32);

/** Pretends `template` (authored by alice) was unwrapped by bob. */
const validated = (template: NostrEventTemplate): ValidatedRumor => {
  const rumor = createRumor(template, alice.publicKeyHex);
  return {
    wrapId: "11".repeat(32),
    wrapPubkey: WRAP_PUBKEY,
    senderPubkey: rumor.pubkey,
    rumor,
  };
};

const classify = (template: NostrEventTemplate): Either.Either<ChatEvent, { reason: ChatRumorRejectionReason }> =>
  classifyRumor(validated(template), {
    recipientSecretKey: bob.secretKey,
    recipientPublicKeyHex: bob.publicKeyHex,
  });

const expectEvent = (template: NostrEventTemplate): ChatEvent => {
  const result = classify(template);
  if (Either.isLeft(result)) throw new Error(`unexpected rejection: ${result.left.reason}`);
  return result.right;
};

const expectRejection = (template: NostrEventTemplate, reason: ChatRumorRejectionReason): void => {
  const result = classify(template);
  expect(Either.isLeft(result)).toBe(true);
  if (Either.isLeft(result)) expect(result.left.reason).toBe(reason);
};

describe("kind 14 messages", () => {
  it("classifies a plain message with PoC tags", () => {
    const template = makeChatMessageTemplate({
      senderPublicKeyHex: alice.publicKeyHex,
      recipientPublicKeyHex: bob.publicKeyHex,
      content: "hello",
      createdAtSec: AT,
      clientTag: "c-1",
    });
    expect(template.tags).toStrictEqual([
      ["p", bob.publicKeyHex],
      ["p", alice.publicKeyHex],
      ["client", "c-1"],
    ]);
    expect(expectEvent(template)).toMatchObject({
      _tag: "ChatMessage",
      senderPubkey: alice.publicKeyHex,
      content: "hello",
      createdAtSec: AT,
      clientTag: "c-1",
      taggedPubkeys: [bob.publicKeyHex, alice.publicKeyHex],
      replyToId: null,
      rootMessageId: null,
    });
  });

  it("carries reply context (root defaults to the replied-to message)", () => {
    const replyToId = "22".repeat(32);
    const template = makeChatMessageTemplate({
      senderPublicKeyHex: alice.publicKeyHex,
      recipientPublicKeyHex: bob.publicKeyHex,
      content: "re: hello",
      createdAtSec: AT,
      reply: { replyToId },
    });
    expect(template.tags).toContainEqual(["e", replyToId, "", "root"]);
    expect(template.tags).toContainEqual(["e", replyToId, "", "reply"]);
    expect(expectEvent(template)).toMatchObject({
      _tag: "ChatMessage",
      replyToId,
      rootMessageId: replyToId,
    });
  });

  it("keeps distinct root and reply ids in threads", () => {
    const rootId = "33".repeat(32);
    const replyToId = "44".repeat(32);
    const template = makeChatMessageTemplate({
      senderPublicKeyHex: alice.publicKeyHex,
      recipientPublicKeyHex: bob.publicKeyHex,
      content: "deep reply",
      createdAtSec: AT,
      reply: { replyToId, rootMessageId: rootId },
    });
    expect(expectEvent(template)).toMatchObject({ replyToId, rootMessageId: rootId });
  });

  it("classifies an edited_from message as ChatMessageEdit", () => {
    const editedFromId = "55".repeat(32);
    const template = makeChatEditTemplate({
      senderPublicKeyHex: alice.publicKeyHex,
      recipientPublicKeyHex: bob.publicKeyHex,
      content: "hello (edited)",
      createdAtSec: AT,
      editedFromId,
      clientTag: "c-2",
    });
    expect(template.tags).toContainEqual(["edited_from", editedFromId]);
    expect(expectEvent(template)).toMatchObject({
      _tag: "ChatMessageEdit",
      editedFromId,
      content: "hello (edited)",
      clientTag: "c-2",
    });
  });

  it("rejects blank content", () => {
    expectRejection(
      { kind: 14, created_at: AT, tags: [["p", bob.publicKeyHex]], content: "   \n " },
      "empty-content",
    );
  });

  it("rejects nested NIP-44 ciphertext posing as text (any candidate key)", () => {
    const nestedForSender = encryptNip44(
      "hidden",
      getConversationKey(bob.secretKey, alice.publicKeyHex),
      new Uint8Array(32).fill(3),
    );
    expectRejection(
      {
        kind: 14,
        created_at: AT,
        tags: [
          ["p", bob.publicKeyHex],
          ["p", alice.publicKeyHex],
        ],
        content: nestedForSender,
      },
      "nested-encrypted-content",
    );
  });

  it("accepts text that merely looks base64-ish", () => {
    const template = makeChatMessageTemplate({
      senderPublicKeyHex: alice.publicKeyHex,
      recipientPublicKeyHex: bob.publicKeyHex,
      content: "QWxhZGRpbjpvcGVuIHNlc2FtZQ==".repeat(8),
      createdAtSec: AT,
    });
    expect(expectEvent(template)._tag).toBe("ChatMessage");
  });
});

describe("kind 7 reactions", () => {
  const messageRumorId = "66".repeat(32);

  it("classifies a PoC-shaped reaction", () => {
    const template = makeChatReactionTemplate({
      senderPublicKeyHex: alice.publicKeyHex,
      recipientPublicKeyHex: bob.publicKeyHex,
      messageAuthorPublicKeyHex: bob.publicKeyHex,
      messageRumorId,
      emoji: "🔥",
      createdAtSec: AT,
      clientTag: "c-3",
    });
    expect(template.tags).toStrictEqual([
      ["p", bob.publicKeyHex],
      ["p", bob.publicKeyHex],
      ["p", alice.publicKeyHex],
      ["e", messageRumorId],
      ["k", "14"],
      ["client", "c-3"],
    ]);
    expect(expectEvent(template)).toMatchObject({
      _tag: "ChatReaction",
      emoji: "🔥",
      messageRumorId,
      clientTag: "c-3",
    });
  });

  it("rejects reactions without a target", () => {
    expectRejection({ kind: 7, created_at: AT, tags: [["k", "14"]], content: "👍" }, "missing-target");
  });

  it("rejects reactions targeting a non-chat kind", () => {
    expectRejection(
      { kind: 7, created_at: AT, tags: [["e", messageRumorId], ["k", "1"]], content: "👍" },
      "wrong-target-kind",
    );
  });

  it("rejects empty reaction content", () => {
    expectRejection(
      { kind: 7, created_at: AT, tags: [["e", messageRumorId], ["k", "14"]], content: " " },
      "empty-content",
    );
  });
});

describe("kind 5 deletions", () => {
  it("classifies deletions with unique targets in order", () => {
    const a = "77".repeat(32);
    const b = "88".repeat(32);
    const template = makeChatDeletionTemplate({
      senderPublicKeyHex: alice.publicKeyHex,
      recipientPublicKeyHex: bob.publicKeyHex,
      targetRumorIds: [a, b],
      createdAtSec: AT,
    });
    const withDuplicates: NostrEventTemplate = {
      ...template,
      tags: [...template.tags, ["e", a]],
    };
    expect(expectEvent(withDuplicates)).toMatchObject({
      _tag: "ChatDeletion",
      targetRumorIds: [a, b],
    });
  });

  it("rejects deletions without targets", () => {
    expectRejection({ kind: 5, created_at: AT, tags: [], content: "" }, "missing-target");
  });
});

describe("other kinds", () => {
  it("rejects unsupported rumor kinds", () => {
    expectRejection({ kind: 1, created_at: AT, tags: [], content: "a public note" }, "unsupported-kind");
    expectRejection({ kind: 1059, created_at: AT, tags: [], content: "wrap-in-wrap" }, "unsupported-kind");
  });
});

describe("extractReplyContext (PoC parity)", () => {
  const id1 = "aa".repeat(32);
  const id2 = "bb".repeat(32);

  it("single unmarked e tag is a root, not a reply", () => {
    expect(extractReplyContext([["e", id1]])).toStrictEqual({
      replyToId: null,
      rootMessageId: id1,
    });
  });

  it("two unmarked e tags: first is root, last is reply", () => {
    expect(extractReplyContext([["e", id1], ["e", id2]])).toStrictEqual({
      replyToId: id2,
      rootMessageId: id1,
    });
  });

  it("explicit markers win regardless of order", () => {
    expect(
      extractReplyContext([
        ["e", id2, "", "reply"],
        ["e", id1, "", "root"],
      ]),
    ).toStrictEqual({ replyToId: id2, rootMessageId: id1 });
  });

  it("no e tags -> no context", () => {
    expect(extractReplyContext([["p", alice.publicKeyHex]])).toStrictEqual({
      replyToId: null,
      rootMessageId: null,
    });
  });
});
