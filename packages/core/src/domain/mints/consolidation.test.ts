/**
 * Unit tests for the consolidation policy pieces that are inline code in
 * the PoC (not importable functions — semantics replicated and documented
 * in consolidation.ts): source selection, the autoswap trigger signature,
 * probe sizing and the test-mint force-disable guard. The importable PoC
 * functions are pinned by consolidation.golden.test.ts instead.
 */
import { describe, expect, it } from "vitest";

import { computeWalletBalances } from "../cashu/balances.js";
import {
  AUTOSWAP_MIN_SOURCE_SUM,
  applyConsolidationSizing,
  autoswapTriggerSignature,
  selectConsolidationSource,
  shouldForceDisableAutoswap,
  sizeConsolidationFirstAttempt,
} from "./consolidation.js";

const MAIN = "https://main.example.com";
const FOREIGN_A = "https://a.example.com";
const FOREIGN_B = "https://b.example.com";

const balancesOf = (
  rows: ReadonlyArray<{ mintUrl: string; amount: number; state?: "accepted" | "pending" }>,
) =>
  computeWalletBalances(
    rows.map((row) => ({
      mintUrl: row.mintUrl,
      unit: "sat",
      amount: row.amount,
      state: row.state ?? ("accepted" as const),
    })),
  );

describe("selectConsolidationSource", () => {
  it("picks the largest foreign spendable balance, never the main mint", () => {
    const balances = balancesOf([
      { mintUrl: MAIN, amount: 10_000 },
      { mintUrl: FOREIGN_A, amount: 200 },
      { mintUrl: FOREIGN_B, amount: 500 },
    ]);
    expect(selectConsolidationSource(balances, MAIN)).toEqual({
      mintUrl: FOREIGN_B,
      spendableSat: 500,
    });
  });

  it("counts spendable (accepted) value only — pending rows do not qualify", () => {
    const balances = balancesOf([
      { mintUrl: FOREIGN_A, amount: 90, state: "accepted" },
      { mintUrl: FOREIGN_A, amount: 500, state: "pending" },
      { mintUrl: FOREIGN_B, amount: 100 },
    ]);
    expect(selectConsolidationSource(balances, MAIN)).toEqual({
      mintUrl: FOREIGN_B,
      spendableSat: 100,
    });
  });

  it("matches the main mint after canonicalization (trailing slash, case)", () => {
    const balances = balancesOf([{ mintUrl: FOREIGN_A, amount: 300 }]);
    expect(selectConsolidationSource(balances, `${FOREIGN_A.toUpperCase()}/`)).toBeNull();
  });

  it("null when no foreign mint holds spendable value", () => {
    expect(selectConsolidationSource(balancesOf([{ mintUrl: MAIN, amount: 999 }]), MAIN)).toBeNull();
    expect(selectConsolidationSource(balancesOf([]), MAIN)).toBeNull();
  });

  it("ties resolve to the lexicographically first mint URL (documented divergence)", () => {
    const balances = balancesOf([
      { mintUrl: FOREIGN_B, amount: 250 },
      { mintUrl: FOREIGN_A, amount: 250 },
    ]);
    expect(selectConsolidationSource(balances, MAIN)?.mintUrl).toBe(FOREIGN_A);
  });
});

describe("autoswapTriggerSignature", () => {
  it("null below the 128-sat threshold, set at/above it (PoC autoswapSignature)", () => {
    const below = { mintUrl: FOREIGN_A, spendableSat: AUTOSWAP_MIN_SOURCE_SUM - 1 };
    const at = { mintUrl: FOREIGN_A, spendableSat: AUTOSWAP_MIN_SOURCE_SUM };
    expect(autoswapTriggerSignature(below, 2)).toBeNull();
    expect(autoswapTriggerSignature(at, 2)).toBe(`${FOREIGN_A}|128|2`);
    expect(autoswapTriggerSignature(null, 0)).toBeNull();
  });

  it("changes when the sum or record count changes (re-arm semantics)", () => {
    const source = { mintUrl: FOREIGN_A, spendableSat: 500 };
    expect(autoswapTriggerSignature(source, 2)).not.toBe(
      autoswapTriggerSignature({ ...source, spendableSat: 501 }, 2),
    );
    expect(autoswapTriggerSignature(source, 2)).not.toBe(autoswapTriggerSignature(source, 3));
  });
});

describe("sizeConsolidationFirstAttempt / applyConsolidationSizing", () => {
  it("sizes the first attempt to balance - fee_reserve - input_fee", () => {
    expect(sizeConsolidationFirstAttempt(100, 2, 0)).toBe(98);
    expect(sizeConsolidationFirstAttempt(100, 2, 1)).toBe(97);
  });

  it("null when sizing would not change anything (no fees)", () => {
    expect(sizeConsolidationFirstAttempt(100, 0, 0)).toBeNull();
  });

  it("floors at 1 sat when fees exceed the balance (PoC Math.max(1, …))", () => {
    expect(sizeConsolidationFirstAttempt(3, 5, 1)).toBe(1);
  });

  it("null for a non-positive balance", () => {
    expect(sizeConsolidationFirstAttempt(0, 2, 0)).toBeNull();
    expect(sizeConsolidationFirstAttempt(-10, 2, 0)).toBeNull();
  });

  it("promotes the sized amount and keeps only lower ladder steps (PoC queue rewrite)", () => {
    expect(applyConsolidationSizing([100, 99, 98, 97, 95], 98)).toEqual([98, 97, 95]);
    expect(applyConsolidationSizing([100, 99], 1)).toEqual([1]);
  });
});

describe("shouldForceDisableAutoswap", () => {
  it("true for test mints (incl. the rewrite's superset), false otherwise", () => {
    expect(shouldForceDisableAutoswap("https://testnut.cashu.space")).toBe(true);
    expect(shouldForceDisableAutoswap("https://testnut.cashu.space/")).toBe(true);
    expect(shouldForceDisableAutoswap("https://nofees.testnut.cashu.space")).toBe(true);
    expect(shouldForceDisableAutoswap("https://cashu.cz")).toBe(false);
  });
});
