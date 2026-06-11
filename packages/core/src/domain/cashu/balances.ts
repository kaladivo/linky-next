/**
 * Balance computation over token records (issue #33; `wallet.balance` in the
 * feature map). Pure folds over `{ mintUrl, unit, amount, state }` — works on
 * full {@link TokenRecord}s or any storage row projection.
 *
 * Semantics (feature-map contract):
 *
 * - **spendable** — immediately usable value: `accepted` rows only.
 *   "Spendable balance excludes unavailable, spent, deleted, and
 *   externalized tokens."
 * - **total** — value the wallet still tracks as its own: spendable plus the
 *   temporarily-unavailable states (`issued`, `pending`, `reserved`,
 *   `externalized` — all returnable via `Return`). `spent`/`deleted` are
 *   gone; `error` value is unverified and only re-enters via `Recover`.
 *   Invariant: `spendable ≤ total` per slice.
 *
 * Amounts are only ever summed within one `(mint, unit)` pair, then within
 * one unit across mints — never across units (sat + usd is meaningless).
 * Wallet home (#36) reads: main mint balance via {@link splitByMainMint} /
 * {@link mintBalanceFor}, foreign mint balances from `foreign`, and the
 * headline numbers from {@link unitBalanceFor}.
 */
import { normalizeMintUrl } from "../../ports/CounterStore.js";
import type { TokenState } from "./tokenState.js";
import { countsTowardTotalBalance, isSpendableTokenState } from "./tokenState.js";

/** Minimal structural input — `TokenRecord` satisfies it. */
export interface BalanceTokenInput {
  readonly mintUrl: string;
  readonly unit: string;
  readonly amount: number;
  readonly state: TokenState;
}

export interface BalanceSlice {
  /** All value still attributable to the wallet (see module doc). */
  readonly total: number;
  /** Immediately usable value (`accepted` only). Always ≤ `total`. */
  readonly spendable: number;
}

export const ZERO_BALANCE: BalanceSlice = { total: 0, spendable: 0 };

export interface UnitBalance extends BalanceSlice {
  readonly unit: string;
}

export interface MintBalance {
  /** Normalized mint URL. */
  readonly mintUrl: string;
  /** Per-unit slices at this mint, sorted by unit. */
  readonly byUnit: ReadonlyArray<UnitBalance>;
}

export interface WalletBalances {
  /** Cross-mint per-unit slices, sorted by unit. */
  readonly byUnit: ReadonlyArray<UnitBalance>;
  /** Per-mint breakdowns, sorted by mint URL. */
  readonly byMint: ReadonlyArray<MintBalance>;
}

/** Defensive amount read: non-finite or negative amounts count as 0. */
const safeAmount = (amount: number): number =>
  Number.isFinite(amount) && amount > 0 ? amount : 0;

const normalizeUnit = (unit: string): string => unit.trim() || "sat";

/**
 * Folds a record collection into per-unit and per-mint balances. States
 * outside the spendable/total sets contribute nothing — `spent`, `deleted`
 * and `error` rows never count toward any number, and mints/units whose
 * every row is excluded do not appear in the breakdowns at all.
 */
export const computeWalletBalances = (
  records: Iterable<BalanceTokenInput>,
): WalletBalances => {
  // mint -> unit -> mutable slice
  const perMint = new Map<string, Map<string, { total: number; spendable: number }>>();

  for (const record of records) {
    if (!countsTowardTotalBalance(record.state)) continue;
    const amount = safeAmount(record.amount);
    if (amount === 0) continue;

    const mintUrl = normalizeMintUrl(record.mintUrl);
    if (mintUrl === "") continue;
    const unit = normalizeUnit(record.unit);

    let units = perMint.get(mintUrl);
    if (units === undefined) {
      units = new Map();
      perMint.set(mintUrl, units);
    }
    let slice = units.get(unit);
    if (slice === undefined) {
      slice = { total: 0, spendable: 0 };
      units.set(unit, slice);
    }
    slice.total += amount;
    if (isSpendableTokenState(record.state)) slice.spendable += amount;
  }

  const byMint: MintBalance[] = [...perMint.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([mintUrl, units]) => ({
      mintUrl,
      byUnit: [...units.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([unit, slice]) => ({ unit, total: slice.total, spendable: slice.spendable })),
    }));

  const perUnit = new Map<string, { total: number; spendable: number }>();
  for (const mint of byMint) {
    for (const unitBalance of mint.byUnit) {
      let slice = perUnit.get(unitBalance.unit);
      if (slice === undefined) {
        slice = { total: 0, spendable: 0 };
        perUnit.set(unitBalance.unit, slice);
      }
      slice.total += unitBalance.total;
      slice.spendable += unitBalance.spendable;
    }
  }
  const byUnit: UnitBalance[] = [...perUnit.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([unit, slice]) => ({ unit, total: slice.total, spendable: slice.spendable }));

  return { byUnit, byMint };
};

/** Cross-mint slice for one unit (`ZERO_BALANCE` when absent). */
export const unitBalanceFor = (balances: WalletBalances, unit: string): BalanceSlice => {
  const normalized = normalizeUnit(unit);
  const found = balances.byUnit.find((entry) => entry.unit === normalized);
  return found === undefined ? ZERO_BALANCE : { total: found.total, spendable: found.spendable };
};

/** Slice for one `(mint, unit)` pair (`ZERO_BALANCE` when absent). */
export const mintBalanceFor = (
  balances: WalletBalances,
  mintUrl: string,
  unit: string,
): BalanceSlice => {
  const normalizedMint = normalizeMintUrl(mintUrl);
  const normalizedUnit = normalizeUnit(unit);
  const mint = balances.byMint.find((entry) => entry.mintUrl === normalizedMint);
  const found = mint?.byUnit.find((entry) => entry.unit === normalizedUnit);
  return found === undefined ? ZERO_BALANCE : { total: found.total, spendable: found.spendable };
};

export interface MainAndForeignBalances {
  /**
   * The configured main mint's breakdown — present (possibly with an empty
   * `byUnit`) even when the wallet holds nothing there.
   */
  readonly main: MintBalance;
  /** Every other mint holding value, sorted by mint URL. */
  readonly foreign: ReadonlyArray<MintBalance>;
}

/**
 * Wallet-home (#36) split: the main mint's balances vs every foreign mint
 * still holding value.
 */
export const splitByMainMint = (
  balances: WalletBalances,
  mainMintUrl: string,
): MainAndForeignBalances => {
  const normalizedMain = normalizeMintUrl(mainMintUrl);
  const main = balances.byMint.find((entry) => entry.mintUrl === normalizedMain) ?? {
    mintUrl: normalizedMain,
    byUnit: [],
  };
  return {
    main,
    foreign: balances.byMint.filter((entry) => entry.mintUrl !== normalizedMain),
  };
};
