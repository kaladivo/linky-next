/**
 * chatPaymentsModel (#44 + #45): token/request/decline message detection,
 * pay-input parsing, latest-response-wins and the declined-id derivation.
 * The token and creq strings are PoC-generated golden values from
 * packages/core/src/domain/chat/__fixtures__/chatPayments.golden.json and
 * paymentRequests.golden.json (encoded by the PoC's own deps).
 */
import type { MessageRecord } from "@linky/evolu-store";
import { describe, expect, it } from "vitest";

import {
  CHAT_PAY_TRANSACTION_CATEGORY,
  CHAT_PAY_TRANSACTION_METHOD,
  contactPayMethodOptions,
  declinedRequestIds,
  declineMessageInfo,
  latestRequestResponses,
  mintHostOf,
  parseChatPayAmount,
  requestMessageInfo,
  tokenMessageInfo,
} from "./chatPaymentsModel";

const GOLDEN_TOKEN =
  "cashuBo2FteCJodHRwczovL25vZmVlcy50ZXN0bnV0LmNhc2h1LnNwYWNlYXVjc2F0YXSBomFpSACaHykyU-QeYXCCo2FhAmFzeEA0MDc5MTViYzIxMmJlNjFhNzdlM2U2ZDJhZWI0YzcyNzk4MGJkYTUxY2QwNmE2YWZjMjllMjg2MTc2OGE3ODM3YWNYIQK8kJeZfYGvssxzRrXkNFqTRr0qUG63lYWYpy8M-FFj6qNhYQhhc3hAZmUxNTEwOTMxNGU2MWQ3NzU2YjBmOGVlMGYyM2E2MjRhY2FhM2Y0ZTA0MmY2MTQzM2M3MjhjNzA1N2I5MzFiZWFjWCECno5QULiQp9bAlo2xa8HV1foEDqHeKE9uxp1hKZ9nEFk";

describe("tokenMessageInfo", () => {
  it("decodes a bare-token message (the PoC send shape)", () => {
    const info = tokenMessageInfo(GOLDEN_TOKEN);
    expect(info).not.toBeNull();
    expect(info).toMatchObject({
      tokenText: GOLDEN_TOKEN,
      amountSat: 10,
      mintUrl: "https://nofees.testnut.cashu.space",
      unit: "sat",
    });
  });

  it("finds a token embedded in surrounding text (PoC extraction)", () => {
    const info = tokenMessageInfo(`here you go\n${GOLDEN_TOKEN}\nthanks!`);
    expect(info?.tokenText).toBe(GOLDEN_TOKEN);
  });

  it("returns null for plain text and token-ish garbage", () => {
    expect(tokenMessageInfo("hello there")).toBeNull();
    expect(tokenMessageInfo("cashuBnotARealToken")).toBeNull();
    expect(tokenMessageInfo("")).toBeNull();
  });
});

describe("parseChatPayAmount", () => {
  it("accepts positive integers (whitespace tolerated)", () => {
    expect(parseChatPayAmount("21")).toBe(21);
    expect(parseChatPayAmount(" 1 000 ")).toBe(1000);
  });

  it("rejects zero, negatives, decimals and garbage", () => {
    expect(parseChatPayAmount("0")).toBeNull();
    expect(parseChatPayAmount("-5")).toBeNull();
    expect(parseChatPayAmount("1.5")).toBeNull();
    expect(parseChatPayAmount("abc")).toBeNull();
    expect(parseChatPayAmount("")).toBeNull();
  });
});

describe("constants (#43 merge / title contracts)", () => {
  it("spend/receive rows render as contact transactions", () => {
    expect(CHAT_PAY_TRANSACTION_CATEGORY).toBe("contacts");
    expect(CHAT_PAY_TRANSACTION_METHOD).toBe("cashu-chat");
  });

  it("mintHostOf strips scheme and path", () => {
    expect(mintHostOf("https://nofees.testnut.cashu.space")).toBe("nofees.testnut.cashu.space");
    expect(mintHostOf("http://localhost:3338/api")).toBe("localhost:3338");
  });
});

// ─── Payment requests (#45) ──────────────────────────────────────────────

/** PoC-generated creq (paymentRequests.golden.json, requestId req-fixture-0001). */
const GOLDEN_CREQ =
  "creqAuQAGYWEYZGF1Y3NhdGFz9WFtgXgiaHR0cHM6Ly9ub2ZlZXMudGVzdG51dC5jYXNodS5zcGFjZWF0gbkAA2F0ZW5vc3RyYWF4p25wcm9maWxlMXF5Mjh3dW1uOGdoajd1bjlkM3NoanRueXY5a2gydWV3ZDloc3pydGh3ZGVuNXRlMGRlaGh4dG52ZGFrcXo5bmh3ZGVuNXRlMHdmamtjY3RlOWNjOHNjbWd2OTZ6dWNtMGQ1cXpwZWZmenF3OWdxZWNyZmU1dWc4M3hlOWNydnE3cTZ6NTJsdXh6ZjZzbjRtbWthNmh2NmcwbGRkMmpzYWeBgmFuYjE3YWlwcmVxLWZpeHR1cmUtMDAwMQ";

const REQUEST_RUMOR_ID = "b8c3dae38b5a4adc076386a9634be53a1b6ebdf4dbf0170f24f9884c775d681e";
const DECLINE_CONTENT = `linky:req-decline:v1:${REQUEST_RUMOR_ID}`;

const message = (overrides: Partial<MessageRecord>): MessageRecord => ({
  id: "m1",
  rumorId: "r1",
  peerNpub: "npub1peer",
  direction: "in",
  content: "hello",
  senderNpub: null,
  wrapId: null,
  sentAtSec: 100,
  status: null,
  replyToRumorId: null,
  editedAtSec: null,
  editHistory: [],
  ...overrides,
});

describe("requestMessageInfo / declineMessageInfo", () => {
  it("decodes the PoC golden request", () => {
    expect(requestMessageInfo(GOLDEN_CREQ)).toMatchObject({
      amountSat: 100,
      unit: "sat",
      requestId: "req-fixture-0001",
      mintUrls: ["https://nofees.testnut.cashu.space"],
    });
  });

  it("returns null for non-requests; decline marker parses separately", () => {
    expect(requestMessageInfo("hello")).toBeNull();
    expect(requestMessageInfo(GOLDEN_TOKEN)).toBeNull();
    expect(declineMessageInfo(DECLINE_CONTENT)).toStrictEqual({
      requestRumorId: REQUEST_RUMOR_ID,
    });
    expect(declineMessageInfo("hello")).toBeNull();
  });
});

describe("latestRequestResponses (latest response wins, PoC ChatPage)", () => {
  const request = message({ id: "req", rumorId: REQUEST_RUMOR_ID, content: GOLDEN_CREQ });

  it("no replies → request absent from the map (card stays 'requested')", () => {
    expect(latestRequestResponses([request]).size).toBe(0);
  });

  it("a decline reply marks it declined; a LATER token reply flips to paid", () => {
    const decline = message({
      id: "d",
      rumorId: "d1",
      content: DECLINE_CONTENT,
      replyToRumorId: REQUEST_RUMOR_ID,
      sentAtSec: 200,
    });
    const pay = message({
      id: "p",
      rumorId: "p1",
      content: GOLDEN_TOKEN,
      replyToRumorId: REQUEST_RUMOR_ID,
      sentAtSec: 300,
    });
    expect(latestRequestResponses([request, decline]).get(REQUEST_RUMOR_ID)).toMatchObject({
      status: "declined",
    });
    expect(latestRequestResponses([request, decline, pay]).get(REQUEST_RUMOR_ID)).toMatchObject(
      { status: "paid", respondedAtSec: 300 },
    );
    // ...and decline-after-pay wins the other way (latest response wins).
    const lateDecline = message({
      id: "d2",
      rumorId: "d2",
      content: DECLINE_CONTENT,
      replyToRumorId: REQUEST_RUMOR_ID,
      sentAtSec: 400,
    });
    expect(
      latestRequestResponses([request, decline, pay, lateDecline]).get(REQUEST_RUMOR_ID),
    ).toMatchObject({ status: "declined" });
  });

  it("plain-text replies never change the status", () => {
    const text = message({
      id: "t",
      rumorId: "t1",
      content: "soon!",
      replyToRumorId: REQUEST_RUMOR_ID,
      sentAtSec: 500,
    });
    expect(latestRequestResponses([request, text]).size).toBe(0);
  });

  it("an equal-timestamp tie goes to the later-seen message (PoC order)", () => {
    const decline = message({
      id: "d",
      rumorId: "d1",
      content: DECLINE_CONTENT,
      replyToRumorId: REQUEST_RUMOR_ID,
      sentAtSec: 200,
    });
    const pay = message({
      id: "p",
      rumorId: "p1",
      content: GOLDEN_TOKEN,
      replyToRumorId: REQUEST_RUMOR_ID,
      sentAtSec: 200,
    });
    expect(latestRequestResponses([decline, pay]).get(REQUEST_RUMOR_ID)).toMatchObject({
      status: "paid",
    });
  });
});

describe("declinedRequestIds (tx.request-status mirror, PoC TransactionsPage)", () => {
  it("maps decline content → request rumor → NUT-18 requestId", () => {
    const declined = declinedRequestIds(
      [{ rumorId: REQUEST_RUMOR_ID, content: GOLDEN_CREQ }],
      [{ content: DECLINE_CONTENT }],
    );
    expect([...declined]).toStrictEqual(["req-fixture-0001"]);
  });

  it("ignores declines for unknown rumors and bare markers", () => {
    expect(
      declinedRequestIds(
        [{ rumorId: REQUEST_RUMOR_ID, content: GOLDEN_CREQ }],
        [{ content: "linky:req-decline:v1:deadbeef" }, { content: "linky:req-decline:v1:" }],
      ).size,
    ).toBe(0);
  });
});

describe("contactPayMethodOptions (chat-pay.contact-method, #46)", () => {
  // Policy table pinned against the PoC's useContactPayMethod +
  // ContactPayPage gating (no wire shape — the queue/choice is local-only).
  const NPUB = "npub1example";
  const LN = "alice@example.org";

  it("both usable → chooser shown, Cashu is the default (PoC preference)", () => {
    expect(
      contactPayMethodOptions({ peerNpub: NPUB, lnAddress: LN, payWithCashuEnabled: true }),
    ).toEqual({
      canUseCashu: true,
      canUseLightning: true,
      defaultMethod: "cashu",
      showChooser: true,
    });
  });

  it("npub only → Cashu without a chooser", () => {
    expect(
      contactPayMethodOptions({ peerNpub: NPUB, lnAddress: null, payWithCashuEnabled: true }),
    ).toEqual({
      canUseCashu: true,
      canUseLightning: false,
      defaultMethod: "cashu",
      showChooser: false,
    });
  });

  it("settings.pay-with-cashu OFF gates Cashu → Lightning when available", () => {
    expect(
      contactPayMethodOptions({ peerNpub: NPUB, lnAddress: LN, payWithCashuEnabled: false }),
    ).toEqual({
      canUseCashu: false,
      canUseLightning: true,
      defaultMethod: "lightning",
      showChooser: false,
    });
  });

  it("settings.pay-with-cashu OFF and no lightning address → nothing payable", () => {
    expect(
      contactPayMethodOptions({ peerNpub: NPUB, lnAddress: "  ", payWithCashuEnabled: false }),
    ).toEqual({
      canUseCashu: false,
      canUseLightning: false,
      defaultMethod: null,
      showChooser: false,
    });
  });

  it("no npub (lightning-only contact) → Lightning regardless of the toggle", () => {
    expect(
      contactPayMethodOptions({ peerNpub: null, lnAddress: LN, payWithCashuEnabled: true }),
    ).toEqual({
      canUseCashu: false,
      canUseLightning: true,
      defaultMethod: "lightning",
      showChooser: false,
    });
  });
});
