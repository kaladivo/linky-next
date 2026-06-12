/**
 * Pure pay-flow rules (#39; `lightning.pay-invoice` / `lightning.pay-address`
 * / `lnurl.pay`) — funding-mint selection, the confirmation countdown format
 * and the failure → copy mapping. Impure half: ./payActions.ts.
 *
 * Mint selection is the PoC's verbatim (`paymentMintSelection.ts`):
 * candidates are the per-mint sums of `accepted` sat records; ordering is
 * sum-descending with the PREFERRED (main) mint sorted LAST — the PoC
 * comparator returns `1` for the preferred mint, so other mints are drained
 * before the main mint's funds are touched — and the payment takes the
 * first single mint whose sum covers the amount (one payment never splits
 * across mints).
 */
import type { TokenRecord } from "@linky/core";
import { normalizeMintUrl } from "@linky/core";

// ---------------------------------------------------------------------------
// Funding-mint candidates (PoC paymentMintSelection port over TokenRecords)
// ---------------------------------------------------------------------------

export interface PayMintCandidate {
  readonly mintUrl: string;
  readonly unit: string;
  /** Sum of the candidate's accepted record amounts. */
  readonly sum: number;
  /** All accepted records at the mint — the whole group funds one payment. */
  readonly records: ReadonlyArray<TokenRecord>;
}

/**
 * Groups `accepted` records of `unit` by mint and orders them PoC-style:
 * sum descending, preferred (main) mint last.
 */
export const buildPayMintCandidates = (
  records: ReadonlyArray<TokenRecord>,
  preferredMintUrl: string | null,
  unit = "sat",
): ReadonlyArray<PayMintCandidate> => {
  const groups = new Map<string, { sum: number; records: TokenRecord[] }>();
  for (const record of records) {
    if (record.state !== "accepted") continue;
    if (record.unit !== unit) continue;
    if (record.mintUrl === "" || record.token.trim() === "") continue;
    const entry = groups.get(record.mintUrl) ?? { sum: 0, records: [] };
    entry.sum += record.amount;
    entry.records.push(record);
    groups.set(record.mintUrl, entry);
  }

  const preferred = normalizeMintUrl(preferredMintUrl ?? "");
  return [...groups.entries()]
    .map(([mintUrl, group]) => ({ mintUrl, unit, ...group }))
    .sort((a, b) => {
      const aPreferred = preferred !== "" && a.mintUrl === preferred;
      const bPreferred = preferred !== "" && b.mintUrl === preferred;
      if (aPreferred !== bPreferred) return aPreferred ? 1 : -1;
      return b.sum - a.sum;
    });
};

/**
 * The single mint funding the payment: the first candidate whose sum covers
 * the amount (PoC `selectSingleMintCandidateForAmount`); null = no single
 * mint covers it.
 */
export const selectPayMintCandidate = (
  candidates: ReadonlyArray<PayMintCandidate>,
  amountSat: number,
): PayMintCandidate | null => {
  if (!Number.isFinite(amountSat) || amountSat <= 0) return candidates[0] ?? null;
  for (const candidate of candidates) {
    if (candidate.sum >= amountSat) return candidate;
  }
  return null;
};

// ---------------------------------------------------------------------------
// Confirmation countdown (PoC LightningInvoiceConfirmModal format)
// ---------------------------------------------------------------------------

/** "1h 2m 3s" / "2m 3s" / "3s"; null = no expiry known or already expired. */
export const formatRemainingLifetime = (remainingSeconds: number | null): string | null => {
  if (remainingSeconds === null || !Number.isFinite(remainingSeconds) || remainingSeconds < 0) {
    return null;
  }
  const totalSeconds = Math.max(0, Math.floor(remainingSeconds));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
};

// ---------------------------------------------------------------------------
// Failure → copy (PoC: `${t("payFailed")}: ${message}`)
// ---------------------------------------------------------------------------

/** Failure outcome of a pay action (see payActions.ts). */
export interface PayFailure {
  readonly kind: "failed";
  readonly errorTag: string;
  /** Support-safe reason detail when the error carried one. */
  readonly detail: string | null;
}

/** All parameterless keys — screens may call `t(key)` directly. */
export type PayFailureKey = "payInsufficient" | "payAmountRequired" | "payFailed";

export interface PayFailureMessage {
  readonly key: PayFailureKey;
  /** Appended after ": " when present (PoC error copy shape). */
  readonly detail: string | null;
}

/**
 * Maps a failure to its user copy. Insufficient funds keeps the PoC's
 * dedicated message; everything else is `payFailed` with the reason detail
 * appended (PoC status-line behavior).
 */
export const payFailureMessage = (failure: PayFailure): PayFailureMessage => {
  switch (failure.errorTag) {
    case "InsufficientFundsError":
      return { key: "payInsufficient", detail: null };
    case "InvoiceAmountRequiredError":
      return { key: "payAmountRequired", detail: null };
    default:
      return { key: "payFailed", detail: failure.detail };
  }
};
