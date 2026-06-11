/**
 * Golden interop tests for NIP-17/NIP-59 + NIP-44 (issue #22).
 *
 * The fixtures in `__fixtures__/nip17.golden.json` were generated FROM THE
 * POC's actual dependencies (`nostr-tools@2.23.3` + the PoC's own
 * `pushWrappedEvent.ts`) before this implementation was written — see
 * `__fixtures__/README.md`. They prove:
 *
 *   - NIP-44: same conversation key; fixed-nonce encryption is
 *     byte-identical to nostr-tools in both directions
 *   - PoC-wrapped events (recipient wrap AND self wrap) unwrap to exactly
 *     the recorded rumor under our `unwrapGiftWrap`
 *   - classification turns each PoC rumor shape into the expected ChatEvent
 *   - the PoC's nested-encrypted spoof case is rejected, not rendered
 */
import { readFileSync } from "node:fs";
import { Either } from "effect";
import { describe, expect, it } from "vitest";

import { hexToBytes } from "../nostr/nostrTestKit.js";
import type { NostrEvent } from "../nostr/NostrEvent.js";
import type { ChatEvent } from "./chatEvents.js";
import { classifyRumor } from "./chatEvents.js";
import type { ChatRumor, ValidatedRumor } from "./giftWrap.js";
import { LINKY_PUSH_MARKER_TAG, unwrapGiftWrap } from "./giftWrap.js";
import { decryptNip44, encryptNip44, getConversationKey } from "./nip44.js";

interface GoldenFixture {
  readonly nostrToolsVersion: string;
  readonly senderSecretKeyHex: string;
  readonly recipientSecretKeyHex: string;
  readonly senderPublicKeyHex: string;
  readonly recipientPublicKeyHex: string;
  readonly nip44: {
    readonly conversationKeyHex: string;
    readonly vectors: ReadonlyArray<{
      readonly plaintext: string;
      readonly nonceHex: string;
      readonly payload: string;
    }>;
  };
  readonly wraps: ReadonlyArray<{
    readonly name: string;
    readonly pushMarkerOnRecipientWrap: boolean;
    readonly rumor: ChatRumor;
    readonly wrapForRecipient: NostrEvent;
    readonly wrapForSender: NostrEvent;
  }>;
}

const fixture = JSON.parse(
  readFileSync(new URL("./__fixtures__/nip17.golden.json", import.meta.url), "utf8"),
) as GoldenFixture;

const senderSecretKey = hexToBytes(fixture.senderSecretKeyHex);
const recipientSecretKey = hexToBytes(fixture.recipientSecretKeyHex);
const bytesToHex = (bytes: Uint8Array): string =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

/** Fixed "now" after fixture generation, so nothing trips the future check. */
const NOW_SEC = 1_781_500_000; // 2026-06-15, a few days past generation

describe("nip44 (nostr-tools compatibility)", () => {
  it("derives the same conversation key, symmetrically", () => {
    const forward = getConversationKey(senderSecretKey, fixture.recipientPublicKeyHex);
    const backward = getConversationKey(recipientSecretKey, fixture.senderPublicKeyHex);
    expect(bytesToHex(forward)).toBe(fixture.nip44.conversationKeyHex);
    expect(bytesToHex(backward)).toBe(fixture.nip44.conversationKeyHex);
  });

  const conversationKey = hexToBytes(fixture.nip44.conversationKeyHex);
  for (const [index, vector] of fixture.nip44.vectors.entries()) {
    it(`vector ${index}: our encrypt is byte-identical to nostr-tools`, () => {
      expect(encryptNip44(vector.plaintext, conversationKey, hexToBytes(vector.nonceHex))).toBe(
        vector.payload,
      );
    });
    it(`vector ${index}: our decrypt recovers the plaintext`, () => {
      expect(decryptNip44(vector.payload, conversationKey)).toBe(vector.plaintext);
    });
  }
});

const expectUnwrapped = (wrap: NostrEvent, secretKey: Uint8Array): ValidatedRumor => {
  const result = unwrapGiftWrap(wrap, secretKey, { nowSec: NOW_SEC });
  if (Either.isLeft(result)) {
    throw new Error(`expected unwrap to succeed, got ${result.left.reason}`);
  }
  return result.right;
};

const expectClassified = (validated: ValidatedRumor): ChatEvent => {
  const result = classifyRumor(validated, {
    recipientSecretKey,
    recipientPublicKeyHex: fixture.recipientPublicKeyHex,
  });
  if (Either.isLeft(result)) {
    throw new Error(`expected classification to succeed, got ${result.left.reason}`);
  }
  return result.right;
};

describe("unwrapGiftWrap (PoC-generated wraps)", () => {
  for (const wrapCase of fixture.wraps) {
    it(`${wrapCase.name}: recipient wrap unwraps to the exact rumor`, () => {
      const validated = expectUnwrapped(wrapCase.wrapForRecipient, recipientSecretKey);
      expect(validated.rumor).toStrictEqual(wrapCase.rumor);
      expect(validated.senderPubkey).toBe(fixture.senderPublicKeyHex);
      expect(validated.wrapId).toBe(wrapCase.wrapForRecipient.id);
    });

    it(`${wrapCase.name}: the sender's self wrap unwraps with the sender key`, () => {
      const validated = expectUnwrapped(wrapCase.wrapForSender, senderSecretKey);
      expect(validated.rumor).toStrictEqual(wrapCase.rumor);
      expect(validated.senderPubkey).toBe(fixture.senderPublicKeyHex);
    });

    it(`${wrapCase.name}: wrap shape matches the PoC (p tag, push marker)`, () => {
      const wrap = wrapCase.wrapForRecipient;
      expect(wrap.kind).toBe(1059);
      expect(wrap.tags[0]).toStrictEqual(["p", fixture.recipientPublicKeyHex]);
      const hasMarker = wrap.tags.some(
        (tag) => tag[0] === LINKY_PUSH_MARKER_TAG[0] && tag[1] === LINKY_PUSH_MARKER_TAG[1],
      );
      expect(hasMarker).toBe(wrapCase.pushMarkerOnRecipientWrap);
      // The ephemeral wrap key is never the sender's real key.
      expect(wrap.pubkey).not.toBe(fixture.senderPublicKeyHex);
    });
  }
});

describe("classifyRumor (PoC rumor shapes)", () => {
  const byName = new Map(fixture.wraps.map((wrapCase) => [wrapCase.name, wrapCase]));
  const classified = (name: string): ChatEvent =>
    expectClassified(expectUnwrapped(byName.get(name)!.wrapForRecipient, recipientSecretKey));

  it("text-message -> ChatMessage with content + client tag", () => {
    const event = classified("text-message");
    expect(event).toMatchObject({
      _tag: "ChatMessage",
      rumorId: byName.get("text-message")!.rumor.id,
      senderPubkey: fixture.senderPublicKeyHex,
      content: "hello from the PoC fixture 👋",
      clientTag: "lk-client-0001",
      replyToId: null,
      rootMessageId: null,
    });
  });

  it("reply-message -> ChatMessage with reply context", () => {
    const originalId = byName.get("text-message")!.rumor.id;
    expect(classified("reply-message")).toMatchObject({
      _tag: "ChatMessage",
      replyToId: originalId,
      rootMessageId: originalId,
    });
  });

  it("edit-message -> ChatMessageEdit pointing at the original rumor id", () => {
    expect(classified("edit-message")).toMatchObject({
      _tag: "ChatMessageEdit",
      editedFromId: byName.get("text-message")!.rumor.id,
      content: "hello from the PoC fixture (edited)",
      clientTag: "lk-client-0003",
    });
  });

  it("reaction -> ChatReaction targeting the message rumor id", () => {
    expect(classified("reaction")).toMatchObject({
      _tag: "ChatReaction",
      emoji: "🔥",
      messageRumorId: byName.get("text-message")!.rumor.id,
      senderPubkey: fixture.senderPublicKeyHex,
    });
  });

  it("delete-reaction -> ChatDeletion with the referenced target", () => {
    expect(classified("delete-reaction")).toMatchObject({
      _tag: "ChatDeletion",
      targetRumorIds: ["5".repeat(64)],
    });
  });

  it("tricky-content -> exact unicode content survives the round trip", () => {
    const event = classified("tricky-content");
    expect(event._tag).toBe("ChatMessage");
    expect((event as Extract<ChatEvent, { _tag: "ChatMessage" }>).content).toBe(
      'newline\n tab\t "quotes" \\backslash\\ čeština 中文 𝄞 🎉',
    );
  });

  it("nested-encrypted-content -> rejected, never rendered as text", () => {
    const validated = expectUnwrapped(
      byName.get("nested-encrypted-content")!.wrapForRecipient,
      recipientSecretKey,
    );
    const result = classifyRumor(validated, {
      recipientSecretKey,
      recipientPublicKeyHex: fixture.recipientPublicKeyHex,
    });
    expect(Either.isLeft(result)).toBe(true);
    expect(Either.isLeft(result) && result.left.reason).toBe("nested-encrypted-content");
  });
});
