/**
 * Pure pay-flow rules: PoC mint-candidate semantics
 * (`paymentMintSelection.ts` port), the confirmation countdown format and
 * the failure copy mapping.
 */
import type { TokenRecord, TokenState } from "@linky/core";
import { describe, expect, it } from "vitest";

import {
  buildPayMintCandidates,
  formatRemainingLifetime,
  payFailureMessage,
  selectPayMintCandidate,
} from "./payModel";

const record = (
  id: string,
  mintUrl: string,
  amount: number,
  state: TokenState = "accepted",
  unit = "sat",
): TokenRecord => ({
  id,
  mintUrl,
  unit,
  amount,
  state,
  token: `cashuB-${id}`,
  error: null,
  createdAtMillis: 1,
  updatedAtMillis: 1,
});

const MINT_A = "https://mint-a.example";
const MINT_B = "https://mint-b.example";
const MINT_MAIN = "https://main.example";

describe("buildPayMintCandidates (PoC ordering)", () => {
  it("groups accepted sat records by mint, sum descending", () => {
    const candidates = buildPayMintCandidates(
      [record("1", MINT_A, 10), record("2", MINT_B, 70), record("3", MINT_A, 20)],
      null,
    );
    expect(candidates.map((c) => [c.mintUrl, c.sum])).toEqual([
      [MINT_B, 70],
      [MINT_A, 30],
    ]);
    expect(candidates[1]?.records.map((r) => r.id)).toEqual(["1", "3"]);
  });

  it("sorts the preferred (main) mint LAST — PoC comparator verbatim", () => {
    const candidates = buildPayMintCandidates(
      [record("1", MINT_MAIN, 500), record("2", MINT_A, 30)],
      MINT_MAIN,
    );
    expect(candidates.map((c) => c.mintUrl)).toEqual([MINT_A, MINT_MAIN]);
  });

  it("ignores non-accepted, non-sat and tokenless records", () => {
    const candidates = buildPayMintCandidates(
      [
        record("1", MINT_A, 10, "reserved"),
        record("2", MINT_A, 10, "spent"),
        record("3", MINT_A, 10, "accepted", "usd"),
        { ...record("4", MINT_A, 10), token: " " },
        record("5", MINT_A, 7),
      ],
      null,
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.sum).toBe(7);
    expect(candidates[0]?.records.map((r) => r.id)).toEqual(["5"]);
  });
});

describe("selectPayMintCandidate (PoC single-mint rule)", () => {
  const candidates = buildPayMintCandidates(
    [record("1", MINT_A, 30), record("2", MINT_MAIN, 500)],
    MINT_MAIN,
  );

  it("takes the first candidate covering the amount (non-main first)", () => {
    expect(selectPayMintCandidate(candidates, 25)?.mintUrl).toBe(MINT_A);
    expect(selectPayMintCandidate(candidates, 100)?.mintUrl).toBe(MINT_MAIN);
  });

  it("returns null when no single mint covers the amount", () => {
    expect(selectPayMintCandidate(candidates, 1000)).toBeNull();
  });

  it("falls back to the first candidate for non-positive amounts (PoC)", () => {
    expect(selectPayMintCandidate(candidates, 0)?.mintUrl).toBe(MINT_A);
    expect(selectPayMintCandidate([], 0)).toBeNull();
  });
});

describe("formatRemainingLifetime (PoC modal format)", () => {
  it("formats h/m/s tiers and clamps to whole seconds", () => {
    expect(formatRemainingLifetime(3723.9)).toBe("1h 2m 3s");
    expect(formatRemainingLifetime(123)).toBe("2m 3s");
    expect(formatRemainingLifetime(9)).toBe("9s");
    expect(formatRemainingLifetime(0)).toBe("0s");
  });

  it("hides expired/unknown countdowns (null)", () => {
    expect(formatRemainingLifetime(-1)).toBeNull();
    expect(formatRemainingLifetime(null)).toBeNull();
    expect(formatRemainingLifetime(Number.NaN)).toBeNull();
  });
});

describe("payFailureMessage", () => {
  it("keeps the dedicated insufficient-funds copy", () => {
    expect(
      payFailureMessage({ kind: "failed", errorTag: "InsufficientFundsError", detail: null }),
    ).toEqual({ key: "payInsufficient", detail: null });
  });

  it("maps amountless invoices to the amount-required copy", () => {
    expect(
      payFailureMessage({ kind: "failed", errorTag: "InvoiceAmountRequiredError", detail: null }),
    ).toEqual({ key: "payAmountRequired", detail: null });
  });

  it("falls back to payFailed with the reason detail (PoC error copy)", () => {
    expect(
      payFailureMessage({ kind: "failed", errorTag: "MintProtocolError", detail: "boom" }),
    ).toEqual({ key: "payFailed", detail: "boom" });
  });
});
