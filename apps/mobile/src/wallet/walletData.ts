/**
 * WalletData — the thin data seam between the wallet home UI (#36) and
 * wallet storage (#35, developed in parallel).
 *
 * THE SEAM (for the #35 merge): everything the wallet home reads about
 * stored value flows through `loadWalletData` below. Today its body folds a
 * dev-seeded in-memory record list with `computeWalletBalances`. When the
 * #35 token repositories land, replace ONLY the body:
 *
 * ```ts
 * export const loadWalletData = Effect.gen(function* () {
 *   const records = yield* cashuTokenRepository.all; // #35 repo, in appLayer
 *   return { balances: computeWalletBalances(records) };
 * });
 * ```
 *
 * (The `R` channel may widen to the repository service — `useEffectQuery`
 * accepts anything ⊆ AppServices, so the screen does not change.)
 *
 * Display preferences (unit / hidden / warning dismissal) are deliberately
 * NOT part of this seam: they are app-level KeyValueStorage prefs
 * (./displayPreferences.ts) and stay untouched by #35.
 */
import type { TokenRecord, WalletBalances } from "@linky/core";
import { computeWalletBalances, unitBalanceFor } from "@linky/core";
import { Effect } from "effect";

export interface WalletData {
  /** Cross-mint / per-mint balance fold over the stored token records. */
  readonly balances: WalletBalances;
}

/** True in dev-client/dev-mode builds; vitest (no RN globals) gets false. */
const isDevBuild = typeof __DEV__ !== "undefined" && __DEV__;

const DEV_MINT_URL = "https://testnut.cashu.space";

const devRecord = (
  id: string,
  amount: number,
  state: TokenRecord["state"],
): TokenRecord => ({
  id,
  mintUrl: DEV_MINT_URL,
  unit: "sat",
  amount,
  state,
  // Not a real Cashu token — dev seed rows exist only to exercise the UI.
  token: `cashuB-dev-seed-${id}`,
  error: null,
  createdAtMillis: 0,
  updatedAtMillis: 0,
});

/**
 * Dev-seeded records, chosen to exercise every wallet-home state at once:
 * spendable > 50k sat (warning threshold) and total > spendable (the
 * "total differs" row): spendable 75 000, total 77 000.
 */
export const DEV_SEED_TOKEN_RECORDS: ReadonlyArray<TokenRecord> = [
  devRecord("dev-accepted-1", 60_000, "accepted"),
  devRecord("dev-accepted-2", 15_000, "accepted"),
  devRecord("dev-pending-1", 1_500, "pending"),
  devRecord("dev-issued-1", 500, "issued"),
  devRecord("dev-spent-1", 9_999, "spent"), // must never count anywhere
];

/**
 * Loads the wallet-home data. Dev builds see the seeded records (until #35
 * wires real storage); production builds see an empty wallet.
 */
export const loadWalletData: Effect.Effect<WalletData> = Effect.sync(() => ({
  balances: computeWalletBalances(isDevBuild ? DEV_SEED_TOKEN_RECORDS : []),
}));

/** Headline numbers for the wallet home: the cross-mint sat slice. */
export const headlineSatBalance = (data: WalletData): { total: number; spendable: number } =>
  unitBalanceFor(data.balances, "sat");
