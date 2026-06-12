/**
 * WalletData — the thin data seam between the wallet home UI (#36) and
 * wallet storage (#35), CLOSED by #37: balances come from the session
 * store's token records through `TokensRepository.balances()` (which
 * delegates all balance math to core's #33 fold).
 *
 * The store is the session-scoped singleton (#26, storeManager.ts), not an
 * `appLayer` service, so the seam reaches it through `getReadyLinkyStore()`
 * instead of the R channel the original seam doc sketched — the wallet home
 * renders behind the boot gate, where the store boot always follows the
 * session. Screens re-query by passing the store data version as a dep
 * (writes call `invalidateStoreData()`).
 *
 * Display preferences (unit / hidden / warning dismissal) are deliberately
 * NOT part of this seam: they are app-level KeyValueStorage prefs
 * (./displayPreferences.ts).
 *
 * Dev seeding moved behind the dev settings action (src/dev/devWalletSeed.ts):
 * it now writes REAL records through TokensRepository, so dev builds see
 * exactly what production sees — persisted storage.
 */
import type { WalletBalances } from "@linky/core";
import { unitBalanceFor } from "@linky/core";
import { createTokensRepository } from "@linky/evolu-store";
import { Effect } from "effect";

import { getReadyLinkyStore } from "../store/storeManager";

export interface WalletData {
  /** Cross-mint / per-mint balance fold over the stored token records. */
  readonly balances: WalletBalances;
}

/**
 * Loads the wallet-home data from the session store. Repository reads
 * cannot fail recoverably (storage read bugs are defects), so E stays
 * `never` and the screen keeps its loading/success branches only.
 */
export const loadWalletData: Effect.Effect<WalletData> = Effect.promise(async () => {
  const store = await getReadyLinkyStore();
  const balances = await createTokensRepository(store).balances();
  return { balances };
});

/** Headline numbers for the wallet home: the cross-mint sat slice. */
export const headlineSatBalance = (data: WalletData): { total: number; spendable: number } =>
  unitBalanceFor(data.balances, "sat");
