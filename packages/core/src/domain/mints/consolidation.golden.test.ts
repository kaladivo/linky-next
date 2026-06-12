/**
 * Golden tests for the consolidation policy (issue #42): the fee-retry
 * ladder, shortage parsing, retryability classification, the failure-driven
 * retry queue and the select-main autoswap plan are pinned against fixtures
 * generated FROM THE POC'S OWN CODE — see `__fixtures__/README.md`
 * (`consolidation.generate.poc.ts.txt` for provenance).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  AUTOSWAP_MIN_SOURCE_SUM,
  buildPaymentAmountAttempts,
  buildPaymentFailureAmountAttempts,
  getPaymentAmountShortage,
  isRetryablePaymentAmountFailure,
  mintSelectionAutoswapPlan,
} from "./consolidation.js";

interface ConsolidationGolden {
  readonly constants: { readonly CASHU_AUTOSWAP_MIN_SOURCE_SUM: number };
  readonly buildPaymentAmountAttempts: ReadonlyArray<{
    requested: number | null;
    available: number;
    output: ReadonlyArray<number>;
  }>;
  readonly getPaymentAmountShortage: ReadonlyArray<{ message: string; output: number | null }>;
  readonly isRetryablePaymentAmountFailure: ReadonlyArray<{ message: string; output: boolean }>;
  readonly buildPaymentFailureAmountAttempts: ReadonlyArray<{
    amount: number;
    message: string;
    output: ReadonlyArray<number>;
  }>;
  readonly getMintSelectionAutoswapPlan: ReadonlyArray<{
    name: string;
    args: {
      cashuAutoswapEnabled: boolean;
      currentMainMintAcceptedBalance: number;
      currentMintUrl: string | null;
      nextMintUrl: string;
    };
    output: {
      shouldDisableAutoswapForTestMint: boolean;
      shouldWarnAboutMintChange: boolean;
    };
  }>;
}

const fixtures = JSON.parse(
  readFileSync(new URL("./__fixtures__/consolidation.golden.json", import.meta.url), "utf8"),
) as ConsolidationGolden;

describe("consolidation.golden — constants", () => {
  it("AUTOSWAP_MIN_SOURCE_SUM matches the PoC CASHU_AUTOSWAP_MIN_SOURCE_SUM", () => {
    expect(AUTOSWAP_MIN_SOURCE_SUM).toBe(fixtures.constants.CASHU_AUTOSWAP_MIN_SOURCE_SUM);
  });
});

describe("consolidation.golden — buildPaymentAmountAttempts", () => {
  for (const { requested, available, output } of fixtures.buildPaymentAmountAttempts) {
    it(`(${String(requested)}, ${String(available)}) -> [${output.join(",")}]`, () => {
      // JSON cannot carry NaN; the generator's NaN case serializes as null.
      const requestedNumber = requested === null ? Number.NaN : requested;
      expect(buildPaymentAmountAttempts(requestedNumber, available)).toEqual(output);
    });
  }
});

describe("consolidation.golden — getPaymentAmountShortage", () => {
  for (const { message, output } of fixtures.getPaymentAmountShortage) {
    it(`${JSON.stringify(message)} -> ${String(output)}`, () => {
      expect(getPaymentAmountShortage(message)).toBe(output);
    });
  }
});

describe("consolidation.golden — isRetryablePaymentAmountFailure", () => {
  for (const { message, output } of fixtures.isRetryablePaymentAmountFailure) {
    it(`${JSON.stringify(message)} -> ${String(output)}`, () => {
      expect(isRetryablePaymentAmountFailure(message)).toBe(output);
    });
  }
});

describe("consolidation.golden — buildPaymentFailureAmountAttempts", () => {
  for (const { amount, message, output } of fixtures.buildPaymentFailureAmountAttempts) {
    it(`(${String(amount)}, ${JSON.stringify(message)}) -> [${output.join(",")}]`, () => {
      expect(buildPaymentFailureAmountAttempts(amount, message)).toEqual(output);
    });
  }
});

describe("consolidation.golden — mintSelectionAutoswapPlan (PoC getMintSelectionAutoswapPlan)", () => {
  for (const { name, args, output } of fixtures.getMintSelectionAutoswapPlan) {
    it(name, () => {
      expect(
        mintSelectionAutoswapPlan({
          autoswapEnabled: args.cashuAutoswapEnabled,
          currentMainSpendableSat: args.currentMainMintAcceptedBalance,
          currentMintUrl: args.currentMintUrl,
          nextMintUrl: args.nextMintUrl,
        }),
      ).toEqual(output);
    });
  }
});
