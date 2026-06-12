/**
 * Golden interop tests for chat payments (issue #44).
 *
 * The fixtures in `__fixtures__/chatPayments.golden.json` were generated
 * FROM THE POC's actual dependencies (nostr-tools@2.23.3 +
 * @cashu/cashu-ts@2.9.0) and the PoC's own send code (`pushWrappedEvent.ts`
 * `createLinkyPaymentNoticeEvent` / `wrapEventWithPushMarker` /
 * `wrapEventWithoutPushMarker` — the exact functions
 * `usePayContactWithCashuMessage.ts` publishes with) BEFORE this
 * implementation was written — see `__fixtures__/README.md`. They prove:
 *
 * - a Cashu token chat message is a plain kind-14 rumor whose content IS
 *   the serialized token; BOTH its wraps are QUIET (no push marker — the
 *   push relay must not alert on the token itself);
 * - our `makeChatMessageTemplate` + `createRumor` rebuild the PoC token
 *   message byte-for-byte (same rumor id);
 * - our token extraction reads the PoC's cashu-ts-encoded token, with the
 *   PoC-parsed amount/mint/unit;
 * - the payment notice is kind 24133 with content `"payment_notice"`, the
 *   `["linky","payment_notice"]` marker, and ONE recipient wrap carrying
 *   the `["linky","push"]` push marker (no self wrap);
 * - our `makePaymentNoticeTemplate` + `createRumor` rebuild the PoC notice
 *   byte-for-byte (same rumor id);
 * - the inbox never renders a notice: `classifyRumor` rejects kind 24133
 *   as `unsupported-kind` (notices are transport-only, PoC parity).
 */
import { readFileSync } from "node:fs";
import { Effect, Either, Option } from "effect";
import { describe, expect, it } from "vitest";

import { extractCashuTokenFromText, parseCashuToken } from "../cashu/tokenCodec.js";
import { hexToBytes } from "../nostr/nostrTestKit.js";
import type { NostrEvent } from "../nostr/NostrEvent.js";
import { classifyRumor, makeChatMessageTemplate } from "./chatEvents.js";
import type { ChatRumor, ValidatedRumor } from "./giftWrap.js";
import { createRumor, LINKY_PUSH_MARKER_TAG, unwrapGiftWrap } from "./giftWrap.js";
import {
  isPaymentNoticeRumor,
  makePaymentNoticeTemplate,
  PAYMENT_NOTICE_KIND,
  PAYMENT_NOTICE_VALUE,
} from "./paymentNotice.js";

interface GoldenFixture {
  readonly senderSecretKeyHex: string;
  readonly recipientSecretKeyHex: string;
  readonly senderPublicKeyHex: string;
  readonly recipientPublicKeyHex: string;
  readonly cashuTokenText: string;
  readonly cashuTokenAmount: number;
  readonly cashuTokenMintUrl: string;
  readonly cashuTokenUnit: string;
  readonly tokenMessage: {
    readonly pushMarkerOnRecipientWrap: boolean;
    readonly rumor: ChatRumor;
    readonly wrapForRecipient: NostrEvent;
    readonly wrapForSender: NostrEvent;
  };
  readonly paymentNotice: {
    readonly kind: number;
    readonly content: string;
    readonly pushMarkerOnRecipientWrap: boolean;
    readonly selfWrap: boolean;
    readonly rumor: ChatRumor;
    readonly wrapForRecipient: NostrEvent;
  };
}

const fixture = JSON.parse(
  readFileSync(new URL("./__fixtures__/chatPayments.golden.json", import.meta.url), "utf8"),
) as GoldenFixture;

const senderSecretKey = hexToBytes(fixture.senderSecretKeyHex);
const recipientSecretKey = hexToBytes(fixture.recipientSecretKeyHex);

/** Fixed "now" after fixture generation, so nothing trips the future check. */
const NOW_SEC = 1_781_500_000;

const expectUnwrapped = (wrap: NostrEvent, secretKey: Uint8Array): ValidatedRumor => {
  const result = unwrapGiftWrap(wrap, secretKey, { nowSec: NOW_SEC });
  if (Either.isLeft(result)) {
    throw new Error(`expected unwrap to succeed, got ${result.left.reason}`);
  }
  return result.right;
};

const hasPushMarker = (wrap: NostrEvent): boolean =>
  wrap.tags.some(
    (tag) => tag[0] === LINKY_PUSH_MARKER_TAG[0] && tag[1] === LINKY_PUSH_MARKER_TAG[1],
  );

describe("cashu token chat message (PoC wire shape)", () => {
  const { tokenMessage } = fixture;

  it("both PoC wraps unwrap to the exact rumor", () => {
    const forRecipient = expectUnwrapped(tokenMessage.wrapForRecipient, recipientSecretKey);
    expect(forRecipient.rumor).toStrictEqual(tokenMessage.rumor);
    const forSender = expectUnwrapped(tokenMessage.wrapForSender, senderSecretKey);
    expect(forSender.rumor).toStrictEqual(tokenMessage.rumor);
  });

  it("token messages are QUIET: no push marker on either wrap", () => {
    expect(tokenMessage.pushMarkerOnRecipientWrap).toBe(false);
    expect(hasPushMarker(tokenMessage.wrapForRecipient)).toBe(false);
    expect(hasPushMarker(tokenMessage.wrapForSender)).toBe(false);
  });

  it("classifies as a plain ChatMessage whose content is the token", () => {
    const validated = expectUnwrapped(tokenMessage.wrapForRecipient, recipientSecretKey);
    const classified = classifyRumor(validated, {
      recipientSecretKey,
      recipientPublicKeyHex: fixture.recipientPublicKeyHex,
    });
    expect(Either.isRight(classified)).toBe(true);
    expect(Either.isRight(classified) && classified.right).toMatchObject({
      _tag: "ChatMessage",
      content: fixture.cashuTokenText,
      clientTag: "lk-client-pay-0001",
    });
  });

  it("our message template rebuilds the PoC rumor byte for byte", () => {
    const rebuilt = createRumor(
      makeChatMessageTemplate({
        senderPublicKeyHex: fixture.senderPublicKeyHex,
        recipientPublicKeyHex: fixture.recipientPublicKeyHex,
        content: fixture.cashuTokenText,
        createdAtSec: tokenMessage.rumor.created_at,
        clientTag: "lk-client-pay-0001",
      }),
      fixture.senderPublicKeyHex,
    );
    expect(rebuilt).toStrictEqual(tokenMessage.rumor);
  });

  it("our extractor + parser read the PoC's cashu-ts token", () => {
    const extracted = extractCashuTokenFromText(tokenMessage.rumor.content);
    expect(Option.isSome(extracted)).toBe(true);
    expect(Option.getOrThrow(extracted)).toBe(fixture.cashuTokenText);
    const parsed = Effect.runSync(parseCashuToken(fixture.cashuTokenText));
    expect(parsed.amount).toBe(fixture.cashuTokenAmount);
    expect(parsed.mintUrl).toBe(fixture.cashuTokenMintUrl);
    expect(parsed.unit).toBe(fixture.cashuTokenUnit);
  });
});

describe("payment notice (PoC wire shape)", () => {
  const { paymentNotice } = fixture;

  it("pins the constants: kind 24133, payment_notice content + marker", () => {
    expect(PAYMENT_NOTICE_KIND).toBe(paymentNotice.kind);
    expect(PAYMENT_NOTICE_VALUE).toBe(paymentNotice.content);
    expect(paymentNotice.rumor.kind).toBe(PAYMENT_NOTICE_KIND);
    expect(paymentNotice.rumor.content).toBe(PAYMENT_NOTICE_VALUE);
    expect(isPaymentNoticeRumor(paymentNotice.rumor)).toBe(true);
  });

  it("the PoC notice wrap unwraps to the exact rumor", () => {
    const validated = expectUnwrapped(paymentNotice.wrapForRecipient, recipientSecretKey);
    expect(validated.rumor).toStrictEqual(paymentNotice.rumor);
    expect(validated.senderPubkey).toBe(fixture.senderPublicKeyHex);
  });

  it("the notice wrap is MARKED (push) and recipient-only (no self wrap)", () => {
    expect(paymentNotice.pushMarkerOnRecipientWrap).toBe(true);
    expect(paymentNotice.selfWrap).toBe(false);
    const wrap = paymentNotice.wrapForRecipient;
    expect(hasPushMarker(wrap)).toBe(true);
    expect(wrap.tags[0]).toStrictEqual(["p", fixture.recipientPublicKeyHex]);
  });

  it("our notice template rebuilds the PoC rumor byte for byte", () => {
    const rebuilt = createRumor(
      makePaymentNoticeTemplate({
        senderPublicKeyHex: fixture.senderPublicKeyHex,
        recipientPublicKeyHex: fixture.recipientPublicKeyHex,
        createdAtSec: paymentNotice.rumor.created_at,
        clientTag: "lk-client-pay-0002",
      }),
      fixture.senderPublicKeyHex,
    );
    expect(rebuilt).toStrictEqual(paymentNotice.rumor);
  });

  it("the inbox never renders a notice: classifyRumor rejects kind 24133", () => {
    const validated = expectUnwrapped(paymentNotice.wrapForRecipient, recipientSecretKey);
    const classified = classifyRumor(validated, {
      recipientSecretKey,
      recipientPublicKeyHex: fixture.recipientPublicKeyHex,
    });
    expect(Either.isLeft(classified)).toBe(true);
    expect(Either.isLeft(classified) && classified.left.reason).toBe("unsupported-kind");
  });

  it("isPaymentNoticeRumor needs BOTH the kind and the marker", () => {
    expect(isPaymentNoticeRumor({ kind: PAYMENT_NOTICE_KIND, tags: [] })).toBe(false);
    expect(
      isPaymentNoticeRumor({ kind: 14, tags: [["linky", "payment_notice"]] }),
    ).toBe(false);
  });
});
