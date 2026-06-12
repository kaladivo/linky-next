/**
 * TEMPORARY dev-only wallet seed (#36 → #37): demo token records inserted
 * through the REAL TokensRepository (no in-memory fakes since the #35 seam
 * closed), so the wallet home shows persisted, relaunch-surviving balances.
 * Triggered from the dev settings seed panel; remove once real flows make
 * it redundant.
 *
 * Record set chosen to exercise every wallet-home state at once: spendable
 * > 50k sat (warning threshold) and total > spendable (the "total differs"
 * row): spendable 75 000, total 77 000. The `token` strings are NOT real
 * Cashu tokens — they only exercise the UI.
 */
import type { TokenState } from "@linky/core";
import type { LinkyStore } from "@linky/evolu-store";
import { createMintsRepository, createTokensRepository } from "@linky/evolu-store";

export const DEV_SEED_MINT_URL = "https://testnut.cashu.space";

export interface DevSeedToken {
  readonly amount: number;
  readonly state: TokenState;
  readonly token: string;
}

const seedToken = (id: string, amount: number, state: TokenState): DevSeedToken => ({
  amount,
  state,
  token: `cashuB-dev-seed-${id}`,
});

export const DEV_SEED_WALLET_TOKENS: ReadonlyArray<DevSeedToken> = [
  seedToken("dev-accepted-1", 60_000, "accepted"),
  seedToken("dev-accepted-2", 15_000, "accepted"),
  seedToken("dev-pending-1", 1_500, "pending"),
  seedToken("dev-issued-1", 500, "issued"),
  seedToken("dev-spent-1", 9_999, "spent"), // must never count anywhere
];

/** Idempotent: re-running after the rows exist is a no-op. */
export const seedDevWallet = async (
  store: LinkyStore,
): Promise<"seeded" | "already-seeded"> => {
  const tokens = createTokensRepository(store);
  const existing = await tokens.list({ mintUrl: DEV_SEED_MINT_URL, includeDeleted: true });
  if (existing.some((record) => record.token.startsWith("cashuB-dev-seed-"))) {
    return "already-seeded";
  }

  const ensured = await createMintsRepository(store).ensure(DEV_SEED_MINT_URL);
  if (!ensured.ok) throw new Error(`seed mint failed: ${ensured.error._tag}`);

  for (const seed of DEV_SEED_WALLET_TOKENS) {
    const inserted = tokens.insert({
      mintUrl: DEV_SEED_MINT_URL,
      unit: "sat",
      amount: seed.amount,
      state: seed.state,
      token: seed.token,
    });
    if (!inserted.ok) throw new Error(`seed token failed: ${inserted.error.reason}`);
  }
  return "seeded";
};
