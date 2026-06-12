/**
 * Unit tests for the NUT-18 payment-request codec (#45) — PoC acceptance
 * rules beyond the golden interop cases (paymentRequests.golden.test.ts).
 */
import { PaymentRequest } from "@cashu/cashu-ts";
import { describe, expect, it } from "vitest";

import { encodeNprofile } from "../nostr/nprofile.js";
import {
  buildPaymentRequestContent,
  buildPaymentRequestDeclineContent,
  parsePaymentRequestContent,
  parsePaymentRequestDeclineContent,
} from "./paymentRequest.js";

const PUBKEY = "e529101c5403381a734e20f1364b81b01e0685457f86127509d77bb77576690f";
const NPROFILE = encodeNprofile({ pubkeyHex: PUBKEY, relays: ["wss://relay.damus.io"] })!;

const build = (overrides: Partial<Parameters<typeof buildPaymentRequestContent>[0]> = {}) =>
  buildPaymentRequestContent({
    amountSat: 21,
    mintUrls: ["https://nofees.testnut.cashu.space"],
    requesterNprofile: NPROFILE,
    requestId: "req-1",
    ...overrides,
  });

describe("buildPaymentRequestContent", () => {
  it("round-trips through the parser, including the description", () => {
    const encoded = build({ description: " coffee " });
    expect(encoded).not.toBeNull();
    const parsed = parsePaymentRequestContent(encoded!);
    expect(parsed).toMatchObject({
      amountSat: 21,
      unit: "sat",
      mintUrls: ["https://nofees.testnut.cashu.space"],
      requestId: "req-1",
      description: "coffee",
      transportNprofile: NPROFILE,
    });
  });

  it("truncates fractional amounts and rejects non-positive ones", () => {
    const encoded = build({ amountSat: 21.9 });
    expect(parsePaymentRequestContent(encoded!)?.amountSat).toBe(21);
    expect(build({ amountSat: 0 })).toBeNull();
    expect(build({ amountSat: -3 })).toBeNull();
    expect(build({ amountSat: Number.NaN })).toBeNull();
  });

  it("drops blank mint urls", () => {
    const encoded = build({ mintUrls: ["  ", "https://mint.example  "] });
    expect(parsePaymentRequestContent(encoded!)?.mintUrls).toStrictEqual([
      "https://mint.example",
    ]);
  });
});

describe("parsePaymentRequestContent (PoC acceptance rules)", () => {
  it("rejects non-sat units (PoC rule), case-insensitively accepts sat", () => {
    const usd = new PaymentRequest(undefined, "r", 100, "usd").toEncodedRequest();
    expect(parsePaymentRequestContent(usd)).toBeNull();
    const upper = new PaymentRequest(undefined, "r", 100, "SAT").toEncodedRequest();
    expect(parsePaymentRequestContent(upper)).toMatchObject({ unit: "sat" });
  });

  it("rejects a missing unit or amount", () => {
    expect(
      parsePaymentRequestContent(new PaymentRequest(undefined, "r", 100).toEncodedRequest()),
    ).toBeNull();
    expect(
      parsePaymentRequestContent(
        new PaymentRequest(undefined, "r", undefined, "sat").toEncodedRequest(),
      ),
    ).toBeNull();
  });

  it("tolerates a missing transport / id (renderable request, null fields)", () => {
    const bare = new PaymentRequest(undefined, undefined, 5, "sat").toEncodedRequest();
    expect(parsePaymentRequestContent(bare)).toMatchObject({
      amountSat: 5,
      requestId: null,
      transportNprofile: null,
      mintUrls: [],
    });
  });

  it("nulls the transport target when it is not a valid nprofile", () => {
    const bogus = new PaymentRequest(
      [{ type: "nostr", target: "not-an-nprofile", tags: [["n", "17"]] }],
      "r",
      5,
      "sat",
    ).toEncodedRequest();
    expect(parsePaymentRequestContent(bogus)).toMatchObject({ transportNprofile: null });
  });

  it("trims surrounding whitespace like the PoC", () => {
    const encoded = build()!;
    expect(parsePaymentRequestContent(`  ${encoded}\n`)?.encoded).toBe(encoded);
  });
});

describe("decline marker", () => {
  it("builds and parses with trimming", () => {
    const content = buildPaymentRequestDeclineContent("  abc  ");
    expect(content).toBe("linky:req-decline:v1:abc");
    expect(parsePaymentRequestDeclineContent(` ${content} `)).toStrictEqual({
      requestRumorId: "abc",
    });
  });

  it("a request never parses as a decline and vice versa", () => {
    const encoded = build()!;
    expect(parsePaymentRequestDeclineContent(encoded)).toBeNull();
    expect(parsePaymentRequestContent("linky:req-decline:v1:abc")).toBeNull();
  });
});
