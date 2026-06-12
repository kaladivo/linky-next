import { describe, expect, it } from "vitest";

import {
  PENDING_TOPUP_QUOTE_MAX_AGE_MS,
  canReusePendingQuote,
  isPendingQuoteStale,
  parsePendingTopupQuote,
  pendingQuoteFromTopupQuote,
  serializePendingTopupQuote,
  topupPollAction,
} from "./topupQuote";
import type { PendingTopupQuote } from "./topupQuote";

const NOW = 1_750_000_000_000;

const quote: PendingTopupQuote = {
  mintUrl: "https://testnut.cashu.space",
  unit: "sat",
  amountSat: 21,
  quoteId: "quote-1",
  invoice: "lnbc210n1pexample",
  expiresAtSec: Math.floor(NOW / 1000) + 600,
  createdAtMs: NOW,
};

describe("pending quote codec", () => {
  it("round-trips through detailsJson", () => {
    expect(parsePendingTopupQuote(serializePendingTopupQuote(quote))).toEqual(quote);
  });

  it("maps a core TopupQuote", () => {
    const mapped = pendingQuoteFromTopupQuote(
      {
        mintUrl: quote.mintUrl,
        unit: "sat",
        amount: 21,
        quoteId: "quote-1",
        invoice: quote.invoice,
        expiresAt: quote.expiresAtSec,
        state: "UNPAID",
      },
      NOW,
    );
    expect(mapped).toEqual(quote);
  });

  it("rejects malformed payloads instead of throwing", () => {
    expect(parsePendingTopupQuote(null)).toBeNull();
    expect(parsePendingTopupQuote("not json")).toBeNull();
    expect(parsePendingTopupQuote("42")).toBeNull();
    expect(parsePendingTopupQuote(JSON.stringify({ quoteId: "q" }))).toBeNull();
    expect(
      parsePendingTopupQuote(JSON.stringify({ ...quote, amountSat: 0 })),
    ).toBeNull();
    expect(
      parsePendingTopupQuote(JSON.stringify({ ...quote, invoice: "" })),
    ).toBeNull();
  });

  it("defaults unit / expiry / createdAt for legacy or sparse payloads", () => {
    const parsed = parsePendingTopupQuote(
      JSON.stringify({
        mintUrl: quote.mintUrl,
        amountSat: 21,
        quoteId: "quote-1",
        invoice: quote.invoice,
      }),
    );
    expect(parsed).toEqual({ ...quote, unit: "sat", expiresAtSec: 0, createdAtMs: 0 });
  });
});

describe("staleness + reuse", () => {
  it("is fresh within the mint expiry and 24h window", () => {
    expect(isPendingQuoteStale(quote, NOW + 1000)).toBe(false);
  });

  it("goes stale past the mint expiry", () => {
    expect(isPendingQuoteStale(quote, quote.expiresAtSec * 1000)).toBe(true);
  });

  it("goes stale past the 24h cache age (PoC parity)", () => {
    const noExpiry = { ...quote, expiresAtSec: 0 };
    expect(isPendingQuoteStale(noExpiry, NOW + PENDING_TOPUP_QUOTE_MAX_AGE_MS)).toBe(false);
    expect(isPendingQuoteStale(noExpiry, NOW + PENDING_TOPUP_QUOTE_MAX_AGE_MS + 1)).toBe(true);
  });

  it("reuses only for the same mint + unit + amount", () => {
    const request = { mintUrl: quote.mintUrl, amountSat: 21 };
    expect(canReusePendingQuote(quote, request, NOW + 1000)).toBe(true);
    expect(canReusePendingQuote(quote, { ...request, amountSat: 42 }, NOW + 1000)).toBe(false);
    expect(
      canReusePendingQuote(quote, { ...request, mintUrl: "https://other.mint" }, NOW + 1000),
    ).toBe(false);
    expect(canReusePendingQuote(quote, { ...request, unit: "usd" }, NOW + 1000)).toBe(false);
  });

  it("never reuses a stale quote", () => {
    const request = { mintUrl: quote.mintUrl, amountSat: 21 };
    expect(canReusePendingQuote(quote, request, quote.expiresAtSec * 1000 + 1)).toBe(false);
  });
});

describe("topupPollAction", () => {
  it("claims for PAID and ISSUED (already-issued still claims, #32)", () => {
    expect(topupPollAction({ state: "PAID", claimable: true })).toBe("claim");
    expect(topupPollAction({ state: "ISSUED", claimable: true })).toBe("claim");
  });

  it("ends the flow on EXPIRED", () => {
    expect(topupPollAction({ state: "EXPIRED", claimable: false })).toBe("expired");
  });

  it("keeps waiting on UNPAID and UNKNOWN", () => {
    expect(topupPollAction({ state: "UNPAID", claimable: false })).toBe("wait");
    expect(topupPollAction({ state: "UNKNOWN", claimable: false })).toBe("wait");
  });
});
