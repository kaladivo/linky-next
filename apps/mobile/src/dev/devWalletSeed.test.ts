/**
 * Guards the dev wallet seed's invariants: the wallet-home verification
 * scenario (#36/#37) relies on the seed exercising every UI state at once.
 */
import { computeWalletBalances, parseCashuToken, unitBalanceFor } from "@linky/core";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { WALLET_WARNING_BALANCE_THRESHOLD_SAT } from "../wallet/walletWarning";
import { DEV_SEED_MINT_URL, DEV_SEED_WALLET_TOKENS } from "./devWalletSeed";

describe("DEV_SEED_WALLET_TOKENS", () => {
  const balance = unitBalanceFor(
    computeWalletBalances(
      DEV_SEED_WALLET_TOKENS.map((seed) => ({
        mintUrl: DEV_SEED_MINT_URL,
        unit: "sat",
        amount: seed.amount,
        state: seed.state,
      })),
    ),
    "sat",
  );

  it("puts the spendable balance over the warning threshold", () => {
    expect(balance.spendable).toBeGreaterThan(WALLET_WARNING_BALANCE_THRESHOLD_SAT);
  });

  it("makes total differ from spendable (so the total row renders)", () => {
    expect(balance.total).toBeGreaterThan(balance.spendable);
  });

  it("never counts the spent or error seed rows", () => {
    expect(balance.total).toBe(78_100);
    expect(balance.spendable).toBe(75_000);
  });

  it("covers the #38 repair states (error / externalized / reserved)", () => {
    const states = new Set(DEV_SEED_WALLET_TOKENS.map((seed) => seed.state));
    for (const state of ["error", "externalized", "reserved", "pending", "issued", "spent"]) {
      expect(states.has(state as never), `missing seed state ${state}`).toBe(true);
    }
  });

  it("seeds structurally valid Cashu tokens (QR/share need decodable text)", () => {
    for (const seed of DEV_SEED_WALLET_TOKENS) {
      const parsed = Effect.runSync(parseCashuToken(seed.token));
      expect(parsed.mintUrl).toBe(DEV_SEED_MINT_URL);
      expect(parsed.amount).toBe(seed.amount);
    }
  });
});
