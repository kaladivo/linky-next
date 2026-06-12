/**
 * Consolidation policy (issue #42; `mints.melt-to-main` / `mints.autoswap`)
 * — the PURE decision logic behind moving foreign-mint balances to the main
 * mint, ported from the PoC and pinned by
 * `__fixtures__/consolidation.golden.json`:
 *
 * - the full-balance fee-retry ladder and failure-driven retry queue
 *   (`paymentAmountFallback.ts`: shortage parsing first, then the
 *   [0,1,2,3,5,8,13,21] fee-reserve steps);
 * - the autoswap trigger threshold (`CASHU_AUTOSWAP_MIN_SOURCE_SUM = 128`
 *   sat — below it the melt fee_reserve typically dominates the balance);
 * - the select-main autoswap plan (`getMintSelectionAutoswapPlan`): picking
 *   a test mint silently disables autoswap; with autoswap on and ≥128 sat
 *   on the current main, warn that funds will be swapped.
 *
 * The impure melt loop lives in `../cashu/meltToMain.ts`; the background
 * trigger and persistence live in the app (it owns repositories/settings).
 */
import { canonicalizeMintUrl } from "./mintUrl.js";
import { isTestMintUrl } from "../environment/EnvironmentConfig.js";
import type { WalletBalances } from "../cashu/balances.js";

/**
 * Autoswap source threshold (PoC `CASHU_AUTOSWAP_MIN_SOURCE_SUM`): a
 * foreign-mint balance below 128 sat is never auto-consolidated — the
 * fee_reserve would eat it and every retry would fail with Insufficient.
 * Manual melt-to-main stays available for any positive balance.
 */
export const AUTOSWAP_MIN_SOURCE_SUM = 128;

/**
 * Hard cap on melt amount attempts per consolidation run (PoC
 * `MAX_AMOUNT_ATTEMPTS`): each attempt creates a fresh mint quote at the
 * target mint and public mints rate-limit quote creation aggressively.
 * Eight matches the ladder's natural length, allowing a 21-sat drop.
 */
export const CONSOLIDATION_MAX_AMOUNT_ATTEMPTS = 8;

/**
 * Pause between amount attempts (PoC: 800ms) — back-to-back quote POSTs
 * trigger 429 on most public mints.
 */
export const CONSOLIDATION_RETRY_DELAY_MILLIS = 800;

/** PoC `FULL_BALANCE_PAYMENT_RETRY_FEE_RESERVES` — the fee-step ladder. */
const FULL_BALANCE_PAYMENT_RETRY_FEE_RESERVES = [0, 1, 2, 3, 5, 8, 13, 21] as const;

const getPositiveInteger = (value: string | undefined): number | null => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.trunc(parsed);
};

/**
 * Parses the sat shortage out of a mint/wallet error message (PoC
 * `getPaymentAmountShortage`): `provided: X, needed: Y`, `need X, have Y`,
 * or a bare `fee: N`. Null when no shortage can be read.
 */
export const getPaymentAmountShortage = (errorMessage: string): number | null => {
  const normalizedMessage = errorMessage.trim();

  const providedNeededMatch = normalizedMessage.match(/provided:\s*(\d+)\s*,\s*needed:\s*(\d+)/i);
  if (providedNeededMatch) {
    const provided = getPositiveInteger(providedNeededMatch[1]);
    const needed = getPositiveInteger(providedNeededMatch[2]);
    if (provided !== null && needed !== null && needed > provided) {
      return needed - provided;
    }
  }

  const needHaveMatch = normalizedMessage.match(/need\s*(\d+)\s*,\s*have\s*(\d+)/i);
  if (needHaveMatch) {
    const needed = getPositiveInteger(needHaveMatch[1]);
    const have = getPositiveInteger(needHaveMatch[2]);
    if (needed !== null && have !== null && needed > have) {
      return needed - have;
    }
  }

  const feeMatch = normalizedMessage.match(/fee\s*:\s*(\d+)/i);
  if (feeMatch) {
    return getPositiveInteger(feeMatch[1]);
  }

  return null;
};

/**
 * Initial attempt queue for "pay/melt `requestedAmountSat`" (PoC
 * `buildPaymentAmountAttempts`): a full-balance payment walks the fee
 * ladder down (the mint needs fee_reserve headroom out of the same
 * balance); any other amount is a single attempt.
 */
export const buildPaymentAmountAttempts = (
  requestedAmountSat: number,
  availableBalanceSat: number,
): number[] => {
  const normalizedRequestedAmount = Math.trunc(requestedAmountSat);
  const normalizedAvailableBalance = Math.trunc(availableBalanceSat);

  if (!Number.isFinite(normalizedRequestedAmount) || normalizedRequestedAmount <= 0) {
    return [];
  }

  if (normalizedRequestedAmount !== normalizedAvailableBalance) {
    return [normalizedRequestedAmount];
  }

  const attempts: number[] = [];
  for (const feeReserveSat of FULL_BALANCE_PAYMENT_RETRY_FEE_RESERVES) {
    const candidateAmount = normalizedRequestedAmount - feeReserveSat;
    if (candidateAmount <= 0 || attempts.includes(candidateAmount)) continue;
    attempts.push(candidateAmount);
  }

  return attempts;
};

/**
 * Whether a failure message means "retry a lower amount" (PoC
 * `isRetryablePaymentAmountFailure`). Anything else (network, protocol,
 * unknown quote, …) aborts the consolidation run.
 */
export const isRetryablePaymentAmountFailure = (errorMessage: string): boolean => {
  const normalizedMessage = errorMessage.trim().toLowerCase();
  return (
    normalizedMessage.includes("insufficient funds") ||
    normalizedMessage.includes("not enough funds") ||
    normalizedMessage.includes("not enough balance") ||
    normalizedMessage.includes("amount out of lnurl range") ||
    normalizedMessage.includes("not enough inputs provided for melt")
  );
};

/**
 * Follow-up attempts after a retryable failure (PoC
 * `buildPaymentFailureAmountAttempts`): prefer stepping by the exact
 * shortage the mint reported (and one below it), then fall back through the
 * fee ladder. For tiny balances this matters — 2 sat with a 1-sat input fee
 * should retry 1 sat, not drop straight to 0.
 */
export const buildPaymentFailureAmountAttempts = (
  requestedAmountSat: number,
  errorMessage: string,
): number[] => {
  const normalizedRequestedAmount = Math.trunc(requestedAmountSat);
  if (
    !Number.isFinite(normalizedRequestedAmount) ||
    normalizedRequestedAmount <= 1 ||
    !isRetryablePaymentAmountFailure(errorMessage)
  ) {
    return [];
  }

  const attempts: number[] = [];
  const pushAttempt = (candidateAmountSat: number): void => {
    const normalizedCandidate = Math.trunc(candidateAmountSat);
    if (
      !Number.isFinite(normalizedCandidate) ||
      normalizedCandidate <= 0 ||
      normalizedCandidate >= normalizedRequestedAmount ||
      attempts.includes(normalizedCandidate)
    ) {
      return;
    }
    attempts.push(normalizedCandidate);
  };

  const shortage = getPaymentAmountShortage(errorMessage);
  if (shortage !== null) {
    pushAttempt(normalizedRequestedAmount - shortage);
    pushAttempt(normalizedRequestedAmount - shortage - 1);
  }

  for (const feeReserveSat of FULL_BALANCE_PAYMENT_RETRY_FEE_RESERVES) {
    if (feeReserveSat <= 0) continue;
    pushAttempt(normalizedRequestedAmount - feeReserveSat);
  }

  return attempts;
};

/**
 * Pre-flight fee sizing (PoC probe step): given the source balance and the
 * discovered melt costs (fee_reserve of a full-balance probe quote + input
 * fees of the spendable proofs), the first real attempt should be
 * `balance - fee_reserve - input_fee` instead of burning the whole ladder
 * on Insufficient. Returns null when sizing doesn't help (no fees, or a
 * nonsensical result) — callers keep the plain ladder then.
 */
export const sizeConsolidationFirstAttempt = (
  sourceBalanceSat: number,
  probeFeeReserveSat: number,
  probeInputFeeSat: number,
): number | null => {
  const balance = Math.trunc(sourceBalanceSat);
  if (!Number.isFinite(balance) || balance <= 0) return null;
  const feeReserve = Number.isFinite(probeFeeReserveSat) ? Math.max(0, Math.trunc(probeFeeReserveSat)) : 0;
  const inputFee = Number.isFinite(probeInputFeeSat) ? Math.max(0, Math.trunc(probeInputFeeSat)) : 0;
  const sized = Math.max(1, balance - feeReserve - inputFee);
  return sized >= 1 && sized < balance ? sized : null;
};

/**
 * Rebuilds the attempt queue around a discovered sized amount (PoC probe
 * queue rewrite): drop the attempts the probe proved will fail (everything
 * ≥ sized) and promote the sized amount to the front, keeping lower ladder
 * steps as fallbacks.
 */
export const applyConsolidationSizing = (
  attempts: ReadonlyArray<number>,
  sizedAmountSat: number,
): number[] => [sizedAmountSat, ...attempts.filter((candidate) => candidate < sizedAmountSat)];

// ---------------------------------------------------------------------------
// Source selection + autoswap trigger
// ---------------------------------------------------------------------------

export interface ConsolidationSource {
  /** Normalized URL of the foreign mint holding the largest balance. */
  readonly mintUrl: string;
  /** Spendable sat sitting there (accepted records only). */
  readonly spendableSat: number;
}

/**
 * The melt-to-main source: the non-main mint with the LARGEST spendable
 * `unit` balance (PoC `largestForeignMintForTokenList` /
 * `meltLargestForeignMintToMainMint` selection — accepted rows only,
 * strictly-greater comparison). Ties resolve to the lexicographically first
 * mint URL (the PoC's row-insertion-order tie-break is not reproducible).
 * Null when no foreign mint holds anything spendable.
 */
export const selectConsolidationSource = (
  balances: WalletBalances,
  mainMintUrl: string,
  unit = "sat",
): ConsolidationSource | null => {
  const main = canonicalizeMintUrl(mainMintUrl);
  let selected: ConsolidationSource | null = null;
  for (const mint of balances.byMint) {
    if (canonicalizeMintUrl(mint.mintUrl) === main) continue;
    const slice = mint.byUnit.find((entry) => entry.unit === unit);
    const spendable = slice?.spendable ?? 0;
    if (spendable <= 0) continue;
    if (selected === null || spendable > selected.spendableSat) {
      selected = { mintUrl: mint.mintUrl, spendableSat: spendable };
    }
  }
  return selected;
};

/**
 * Autoswap trigger signature (PoC `autoswapSignature`): identifies one
 * consolidation opportunity so a failed attempt is not retried in a loop —
 * the runner re-attempts only when the (mint, sum, record-count) tuple
 * changes. Null when the source is below the 128-sat threshold (or absent).
 */
export const autoswapTriggerSignature = (
  source: ConsolidationSource | null,
  recordCount: number,
): string | null => {
  if (source === null) return null;
  if (source.spendableSat < AUTOSWAP_MIN_SOURCE_SUM) return null;
  return `${source.mintUrl}|${String(source.spendableSat)}|${String(recordCount)}`;
};

/**
 * PoC guard (`useAppShellComposition` effect): autoswap may never stay
 * enabled while the MAIN mint is a test mint — melting real foreign value
 * into test ecash would destroy it. Callers persist the setting off.
 */
export const shouldForceDisableAutoswap = (mainMintUrl: string): boolean =>
  isTestMintUrl(canonicalizeMintUrl(mainMintUrl));

// ---------------------------------------------------------------------------
// Select-main autoswap plan (PoC getMintSelectionAutoswapPlan)
// ---------------------------------------------------------------------------

export interface MintSelectionAutoswapPlanArgs {
  readonly autoswapEnabled: boolean;
  /** Spendable sat on the CURRENT main mint. */
  readonly currentMainSpendableSat: number;
  readonly currentMintUrl: string | null;
  readonly nextMintUrl: string;
}

export interface MintSelectionAutoswapPlan {
  /** Selecting a test mint turns autoswap off (when it was on). */
  readonly shouldDisableAutoswapForTestMint: boolean;
  /**
   * Autoswap is on and the current main holds ≥128 sat: warn the user that
   * the change will swap those funds to the new mint (decline = keep the
   * change but disable autoswap).
   */
  readonly shouldWarnAboutMintChange: boolean;
}

/** The `mints.select-main` decision point, pinned by the golden fixtures. */
export const mintSelectionAutoswapPlan = ({
  autoswapEnabled,
  currentMainSpendableSat,
  currentMintUrl,
  nextMintUrl,
}: MintSelectionAutoswapPlanArgs): MintSelectionAutoswapPlan => {
  const currentMint = canonicalizeMintUrl(currentMintUrl ?? "");
  const nextMint = canonicalizeMintUrl(nextMintUrl);

  if (nextMint === "" || nextMint === currentMint) {
    return { shouldDisableAutoswapForTestMint: false, shouldWarnAboutMintChange: false };
  }

  if (isTestMintUrl(nextMint)) {
    return {
      shouldDisableAutoswapForTestMint: autoswapEnabled,
      shouldWarnAboutMintChange: false,
    };
  }

  if (!autoswapEnabled) {
    return { shouldDisableAutoswapForTestMint: false, shouldWarnAboutMintChange: false };
  }

  return {
    shouldDisableAutoswapForTestMint: false,
    shouldWarnAboutMintChange: currentMainSpendableSat >= AUTOSWAP_MIN_SOURCE_SUM,
  };
};
