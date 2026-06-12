/**
 * notificationCopy tests (#52): the rich-vs-generic copy split —
 * `notifications.notify-message` / `notifications.notify-payment`.
 */
import { describe, expect, it } from "vitest";

import {
  GENERIC_NOTIFICATION_COPY,
  messagePreview,
  resolveMessageCopy,
  resolvePaymentCopy,
} from "./notificationCopy";

describe("generic copy", () => {
  it("matches the service's wire copy byte-for-byte (apps/push watcher)", () => {
    // Pinned: the closed-app banner the OS shows comes from the service;
    // this constant documents (and tests against) that exact copy.
    expect(GENERIC_NOTIFICATION_COPY).toEqual({
      title: "Linky",
      body: "You have a new message",
    });
  });
});

describe("resolveMessageCopy (rich, on-device decryption available)", () => {
  it("uses the sender name as title and the content preview as body", () => {
    expect(
      resolveMessageCopy({
        senderName: "Emily",
        content: "  hello there  ",
        isCashuTokenMessage: false,
      }),
    ).toEqual({ title: "Emily", body: "hello there" });
  });

  it("caps the preview at 80 chars (PoC parity)", () => {
    const long = "x".repeat(100);
    expect(messagePreview(long)).toBe(`${"x".repeat(80)}…`);
    expect(
      resolveMessageCopy({ senderName: "Emily", content: long, isCashuTokenMessage: false })!.body,
    ).toHaveLength(81);
  });

  it("keeps Cashu token messages quiet (bearer material is never previewed)", () => {
    expect(
      resolveMessageCopy({
        senderName: "Emily",
        content: "cashuBo...",
        isCashuTokenMessage: true,
      }),
    ).toBeNull();
  });

  it("keeps empty content quiet", () => {
    expect(
      resolveMessageCopy({ senderName: "Emily", content: "   ", isCashuTokenMessage: false }),
    ).toBeNull();
  });
});

describe("resolvePaymentCopy (rich payment alert)", () => {
  const texts = {
    receivedMoneyText: "You received money",
    receivedAmountText: (amountSat: number) => `You received ${String(amountSat)} sat`,
  };

  it("includes the amount when the wallet decrypted+accepted the token", () => {
    expect(resolvePaymentCopy({ senderName: "Emily", amountSat: 21, ...texts })).toEqual({
      title: "Emily",
      body: "You received 21 sat",
    });
  });

  it("falls back to the amount-less copy when no amount is known", () => {
    expect(resolvePaymentCopy({ senderName: "Emily", amountSat: null, ...texts })).toEqual({
      title: "Emily",
      body: "You received money",
    });
    expect(
      resolvePaymentCopy({
        senderName: "Emily",
        amountSat: 0,
        ...texts,
      }).body,
    ).toBe("You received money");
  });
});
