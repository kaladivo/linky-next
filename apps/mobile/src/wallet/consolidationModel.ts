/**
 * Pure consolidation bookkeeping (issue #42; `mints.melt-to-main` /
 * `mints.autoswap`) — no React, no storage; the impure flow lives in
 * ./consolidationActions.ts and the trigger in ./autoswapRunner.ts.
 *
 * ## Where the pending claim is persisted (decided here, PoC divergence)
 *
 * The PoC queued melted-but-unclaimed consolidations in device-local
 * localStorage (`linky.local.pendingAutoswapClaim.v1.<owner>`) and claimed
 * them on a 5s background tick. The rewrite follows the top-up decision
 * (topupQuote.ts): the pending consolidation IS a transaction row
 * (category "cashu", method "swap", status "pending") with the claimable
 * target-mint quote serialized into `detailsJson`. Resume after a crash =
 * "find my pending consolidation rows" — and the row syncs, so any device
 * holding the shared seed can finish the claim.
 *
 * Improvement over the PoC (documented): the quote payload is persisted
 * BEFORE the melt executes (core `meltToMainMint`'s `onQuoteCreated`
 * hook), so a crash between melt and claim cannot lose the quote id. The
 * PoC persisted it only after the melt returned.
 *
 * `detailsJson` secrecy contract holds: quote id + invoice are
 * payment-request material, never proofs/secrets.
 */
import type { PendingTopupQuote } from "./topupQuote";
import { isPendingQuoteStale, parsePendingTopupQuote } from "./topupQuote";

/** `transaction.category` for consolidation rows (mint-to-mint moves). */
export const CONSOLIDATION_TRANSACTION_CATEGORY = "cashu";
/** `transaction.method` for consolidation rows. */
export const CONSOLIDATION_TRANSACTION_METHOD = "swap";

/** Flow phases recorded on the transaction row (free-form breadcrumbs). */
export const CONSOLIDATION_PHASE = {
  /** Row created, melt loop about to run. */
  consolidating: "consolidating",
  /** A target quote exists and the melt attempt for it is executing. */
  melting: "melting",
  /** Melt succeeded; the target quote is claimable but not yet claimed. */
  awaitingClaim: "melted-awaiting-claim",
  claimed: "claimed",
  expired: "expired",
  failed: "failed",
} as const;

/**
 * The pending-claim payload in `detailsJson`: the claimable target-mint
 * quote (same shape the top-up flow persists) plus the source mint for
 * support/history rendering.
 */
export interface PendingConsolidationClaim {
  readonly quote: PendingTopupQuote;
  readonly sourceMintUrl: string;
}

export const serializePendingConsolidationClaim = (claim: PendingConsolidationClaim): string =>
  JSON.stringify({ ...claim.quote, sourceMintUrl: claim.sourceMintUrl });

/** Parses a `detailsJson` payload; null for malformed/quote-less rows. */
export const parsePendingConsolidationClaim = (
  raw: string | null,
): PendingConsolidationClaim | null => {
  const quote = parsePendingTopupQuote(raw);
  if (quote === null) return null;
  let sourceMintUrl = "";
  try {
    const value: unknown = JSON.parse(raw ?? "");
    if (typeof value === "object" && value !== null) {
      const candidate = (value as Record<string, unknown>)["sourceMintUrl"];
      if (typeof candidate === "string") sourceMintUrl = candidate;
    }
  } catch {
    /* quote parsed; the source URL is best-effort metadata */
  }
  return { quote, sourceMintUrl };
};

/** Same staleness rule as pending top-ups (mint expiry / 24h cache age). */
export const isPendingConsolidationStale = (
  claim: PendingConsolidationClaim,
  nowMs: number,
): boolean => isPendingQuoteStale(claim.quote, nowMs);
