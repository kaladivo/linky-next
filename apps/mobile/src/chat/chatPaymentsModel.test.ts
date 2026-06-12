/**
 * chatPaymentsModel (#44): token-message detection + pay-input parsing.
 * The token string is the PoC-generated golden token from
 * packages/core/src/domain/chat/__fixtures__/chatPayments.golden.json
 * (encoded by the PoC's own @cashu/cashu-ts 2.9.0).
 */
import { describe, expect, it } from "vitest";

import {
  CHAT_PAY_TRANSACTION_CATEGORY,
  CHAT_PAY_TRANSACTION_METHOD,
  mintHostOf,
  parseChatPayAmount,
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
