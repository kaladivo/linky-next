/**
 * Pending-consolidation payload semantics (issue #42): round-trip,
 * malformed payload rejection, and the shared staleness rule.
 */
import { describe, expect, it } from "vitest";

import type { PendingConsolidationClaim } from "./consolidationModel";
import {
  isPendingConsolidationStale,
  parsePendingConsolidationClaim,
  serializePendingConsolidationClaim,
} from "./consolidationModel";
import { PENDING_TOPUP_QUOTE_MAX_AGE_MS } from "./topupQuote";

const claim: PendingConsolidationClaim = {
  sourceMintUrl: "https://foreign.example.com",
  quote: {
    mintUrl: "https://main.example.com",
    unit: "sat",
    amountSat: 98,
    quoteId: "quote-7",
    invoice: "lnbc980n1qxyz",
    expiresAtSec: 4_000_000_000,
    createdAtMs: 1_750_000_000_000,
  },
};

describe("pending consolidation claim payload", () => {
  it("round-trips through detailsJson", () => {
    const parsed = parsePendingConsolidationClaim(serializePendingConsolidationClaim(claim));
    expect(parsed).toEqual(claim);
  });

  it("rejects payloads without a claimable quote", () => {
    expect(parsePendingConsolidationClaim(null)).toBeNull();
    expect(parsePendingConsolidationClaim("not json")).toBeNull();
    expect(parsePendingConsolidationClaim(JSON.stringify({ sourceMintUrl: "x" }))).toBeNull();
  });

  it("tolerates a missing sourceMintUrl (claim still completable)", () => {
    const raw = JSON.stringify({ ...claim.quote });
    const parsed = parsePendingConsolidationClaim(raw);
    expect(parsed?.quote.quoteId).toBe("quote-7");
    expect(parsed?.sourceMintUrl).toBe("");
  });

  it("staleness follows the top-up rule (mint expiry / 24h cache age)", () => {
    const now = claim.quote.createdAtMs + 1000;
    expect(isPendingConsolidationStale(claim, now)).toBe(false);
    expect(
      isPendingConsolidationStale(claim, claim.quote.createdAtMs + PENDING_TOPUP_QUOTE_MAX_AGE_MS + 1),
    ).toBe(true);
    const expiring: PendingConsolidationClaim = {
      ...claim,
      quote: { ...claim.quote, expiresAtSec: Math.floor(now / 1000) - 10 },
    };
    expect(isPendingConsolidationStale(expiring, now)).toBe(true);
  });
});
