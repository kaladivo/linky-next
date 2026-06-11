/**
 * Guards the dev seed's invariants: the wallet-home verification scenario
 * (#36) relies on the seed exercising every UI state at once.
 */
import { computeWalletBalances, unitBalanceFor } from "@linky/core";
import { describe, expect, it } from "vitest";

import { DEV_SEED_TOKEN_RECORDS } from "./walletData";
import { WALLET_WARNING_BALANCE_THRESHOLD_SAT } from "./walletWarning";

describe("DEV_SEED_TOKEN_RECORDS", () => {
  const balance = unitBalanceFor(computeWalletBalances(DEV_SEED_TOKEN_RECORDS), "sat");

  it("puts the spendable balance over the warning threshold", () => {
    expect(balance.spendable).toBeGreaterThan(WALLET_WARNING_BALANCE_THRESHOLD_SAT);
  });

  it("makes total differ from spendable (so the total row renders)", () => {
    expect(balance.total).toBeGreaterThan(balance.spendable);
  });

  it("never counts the spent seed row", () => {
    expect(balance.total).toBe(77_000);
    expect(balance.spendable).toBe(75_000);
  });
});
