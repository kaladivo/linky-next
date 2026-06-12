/**
 * TEMPORARY dev-only wallet seed (#36 → #37 → #38): demo token records
 * inserted through the REAL TokensRepository (no in-memory fakes since the
 * #35 seam closed), so the wallet home shows persisted, relaunch-surviving
 * balances. Triggered from the dev settings seed panel; remove once real
 * flows make it redundant.
 *
 * Record set chosen to exercise every wallet-home + token list/detail
 * state at once (#38 added error / externalized / reserved so the repair
 * actions have targets): spendable 75 000 (> the 50k warning threshold),
 * total 78 100 (> spendable, so the "total" row renders).
 *
 * The `token` strings ARE structurally valid Cashu V4 tokens (encoded over
 * deterministic FAKE proofs via core's codec) so the #38 detail screen can
 * render the QR and build the share link — but the proofs are not real
 * mint signatures: any mint-side operation on them fails, which is exactly
 * the dev-verification path for the error UX.
 */
import type { TokenState } from "@linky/core";
import { encodeCashuToken } from "@linky/core";
import type { LinkyStore } from "@linky/evolu-store";
import { createMintsRepository, createTokensRepository } from "@linky/evolu-store";
import { Effect } from "effect";

export const DEV_SEED_MINT_URL = "https://testnut.cashu.space";

/** Marks seeded rows for the idempotence check (memo travels in the token). */
const DEV_SEED_MEMO = "linky-dev-seed";

export interface DevSeedToken {
  readonly amount: number;
  readonly state: TokenState;
  readonly token: string;
  readonly error?: string;
}

/** A deterministic fake proof — valid shape, not a real mint signature. */
const fakeProof = (id: string, amount: number) => ({
  // A well-formed hex keyset id (V4 token encoding requires hex ids).
  id: "009a1f293253e41e",
  amount,
  secret: `linky-dev-seed-${id}`,
  C: `02${"ab".repeat(32)}`,
});

const seedToken = (
  id: string,
  amount: number,
  state: TokenState,
  error?: string,
): DevSeedToken => ({
  amount,
  state,
  token: Effect.runSync(
    encodeCashuToken({
      mintUrl: DEV_SEED_MINT_URL,
      unit: "sat",
      memo: DEV_SEED_MEMO,
      proofs: [fakeProof(id, amount)],
    }),
  ),
  ...(error === undefined ? {} : { error }),
});

export const DEV_SEED_WALLET_TOKENS: ReadonlyArray<DevSeedToken> = [
  seedToken("accepted-1", 60_000, "accepted"),
  seedToken("accepted-2", 15_000, "accepted"),
  seedToken("pending-1", 1_500, "pending"),
  seedToken("issued-1", 500, "issued"),
  seedToken("externalized-1", 300, "externalized"),
  seedToken("reserved-1", 800, "reserved"),
  seedToken("error-1", 700, "error", "mint unreachable during accept"),
  seedToken("spent-1", 9_999, "spent"), // must never count anywhere
];

/** Idempotent: re-running after the rows exist is a no-op. */
export const seedDevWallet = async (
  store: LinkyStore,
): Promise<"seeded" | "already-seeded"> => {
  const tokens = createTokensRepository(store);
  const existing = await tokens.list({ mintUrl: DEV_SEED_MINT_URL, includeDeleted: true });
  const seededTokens = new Set(DEV_SEED_WALLET_TOKENS.map((seed) => seed.token));
  if (existing.some((record) => seededTokens.has(record.token))) {
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
      ...(seed.error === undefined ? {} : { error: seed.error }),
    });
    if (!inserted.ok) throw new Error(`seed token failed: ${inserted.error.reason}`);
  }
  return "seeded";
};
