import { describe, expect, it } from "vitest";

import {
  shouldShowWalletWarning,
  WALLET_WARNING_BALANCE_THRESHOLD_SAT,
  walletWarningApplies,
} from "./walletWarning";

describe("walletWarningApplies", () => {
  it("applies strictly above the PoC 50k sat threshold", () => {
    expect(walletWarningApplies(WALLET_WARNING_BALANCE_THRESHOLD_SAT)).toBe(false);
    expect(walletWarningApplies(WALLET_WARNING_BALANCE_THRESHOLD_SAT + 1)).toBe(true);
    expect(walletWarningApplies(0)).toBe(false);
  });
});

describe("shouldShowWalletWarning", () => {
  it("shows only when applicable and not dismissed", () => {
    const over = WALLET_WARNING_BALANCE_THRESHOLD_SAT + 1;
    expect(shouldShowWalletWarning(over, false)).toBe(true);
    expect(shouldShowWalletWarning(over, true)).toBe(false);
    expect(shouldShowWalletWarning(10, false)).toBe(false);
  });
});
