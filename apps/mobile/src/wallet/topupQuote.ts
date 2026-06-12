/**
 * Pure top-up quote-cache logic (`cashu.topup-quote` / `cashu.claim-topup`,
 * issue #37). No React, no storage — vitest-covered; the impure flow lives
 * in ./topupActions.ts.
 *
 * ## Where pending quotes are persisted (decided here, per the issue)
 *
 * The PoC cached the one pending quote in device-local localStorage
 * (`linky.topup.pending.v1.<owner>`, 24h max age) and recorded the
 * transaction separately. The rewrite folds both into ONE place: the
 * pending top-up's `transaction` row (#35 TransactionsRepository), with the
 * quote payload serialized into `detailsJson`. Rationale:
 *
 * - A pending top-up already needs a phase-tracked transaction row
 *   (`tx.record`: "a flow inserts a pending record up front"), so the row
 *   exists anyway; a second store (metaEntry) would just add a pointer that
 *   can dangle. Resume after app restart = "find my pending top-up rows".
 * - `metaEntry.value` is capped at 1000 chars — a BOLT11 invoice plus the
 *   quote metadata can exceed it; `transaction.detailsJson` is unbounded.
 * - The row syncs on the transactions lane, so any of the user's devices
 *   can claim (the seed is shared; counter collisions are handled by the
 *   #32 recovery ladder).
 *
 * `detailsJson` secrecy contract: a quote id + invoice are payment-request
 * material, not proofs/secrets — support-safe by the `tx.details` rule.
 */
import type { TopupQuote, TopupQuoteStatus } from "@linky/core";

/** `transaction.method` value marking top-up-via-invoice rows. */
export const TOPUP_TRANSACTION_METHOD = "invoice";
/** `transaction.category` value for Lightning top-ups. */
export const TOPUP_TRANSACTION_CATEGORY = "lightning";

/** PoC parity: a cached quote older than 24h is abandoned. */
export const PENDING_TOPUP_QUOTE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** The quote payload cached in the pending transaction's `detailsJson`. */
export interface PendingTopupQuote {
  readonly mintUrl: string;
  readonly unit: string;
  readonly amountSat: number;
  readonly quoteId: string;
  /** BOLT11 invoice shown as QR / copied. */
  readonly invoice: string;
  /** Mint-reported expiry, unix seconds; 0 = unknown. */
  readonly expiresAtSec: number;
  /** When the quote was created locally (for the 24h max age). */
  readonly createdAtMs: number;
}

export const pendingQuoteFromTopupQuote = (
  quote: TopupQuote,
  createdAtMs: number,
): PendingTopupQuote => ({
  mintUrl: quote.mintUrl,
  unit: quote.unit,
  amountSat: quote.amount,
  quoteId: quote.quoteId,
  invoice: quote.invoice,
  expiresAtSec: quote.expiresAt,
  createdAtMs,
});

export const serializePendingTopupQuote = (quote: PendingTopupQuote): string =>
  JSON.stringify(quote);

/** Parses a `detailsJson` payload; null for anything malformed. */
export const parsePendingTopupQuote = (raw: string | null): PendingTopupQuote | null => {
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return null;
    const candidate = value as Record<string, unknown>;
    if (
      typeof candidate["mintUrl"] !== "string" ||
      candidate["mintUrl"].length === 0 ||
      typeof candidate["quoteId"] !== "string" ||
      candidate["quoteId"].length === 0 ||
      typeof candidate["invoice"] !== "string" ||
      candidate["invoice"].length === 0 ||
      typeof candidate["amountSat"] !== "number" ||
      !Number.isFinite(candidate["amountSat"]) ||
      candidate["amountSat"] <= 0
    ) {
      return null;
    }
    return {
      mintUrl: candidate["mintUrl"],
      unit: typeof candidate["unit"] === "string" && candidate["unit"] !== "" ? candidate["unit"] : "sat",
      amountSat: Math.trunc(candidate["amountSat"]),
      quoteId: candidate["quoteId"],
      invoice: candidate["invoice"],
      expiresAtSec:
        typeof candidate["expiresAtSec"] === "number" && Number.isFinite(candidate["expiresAtSec"])
          ? Math.trunc(candidate["expiresAtSec"])
          : 0,
      createdAtMs:
        typeof candidate["createdAtMs"] === "number" && Number.isFinite(candidate["createdAtMs"])
          ? candidate["createdAtMs"]
          : 0,
    };
  } catch {
    return null;
  }
};

/** Locally stale: past the mint expiry or the 24h cache age. */
export const isPendingQuoteStale = (quote: PendingTopupQuote, nowMs: number): boolean => {
  if (nowMs - quote.createdAtMs > PENDING_TOPUP_QUOTE_MAX_AGE_MS) return true;
  return quote.expiresAtSec > 0 && nowMs >= quote.expiresAtSec * 1000;
};

/**
 * Reuse decision (PoC `topupMintQuoteMatchesRequest` + max age): a cached
 * quote serves a new "show invoice" request only for the same mint, unit
 * and amount, and only while fresh.
 */
export const canReusePendingQuote = (
  quote: PendingTopupQuote,
  request: { readonly mintUrl: string; readonly amountSat: number; readonly unit?: string },
  nowMs: number,
): boolean =>
  quote.mintUrl === request.mintUrl &&
  quote.amountSat === request.amountSat &&
  quote.unit === (request.unit ?? "sat") &&
  !isPendingQuoteStale(quote, nowMs);

/** What a polling tick should do with a checked quote. */
export type TopupPollAction = "wait" | "claim" | "expired";

/**
 * Polling decision over core's `checkTopupQuote` result: claimable states
 * (PAID and ISSUED — an already-issued quote still claims, #32) trigger the
 * claim; EXPIRED ends the flow; UNPAID and UNKNOWN (transient mint hiccups)
 * keep waiting.
 */
export const topupPollAction = (
  status: Pick<TopupQuoteStatus, "state" | "claimable">,
): TopupPollAction => {
  if (status.claimable) return "claim";
  if (status.state === "EXPIRED") return "expired";
  return "wait";
};

/** PoC parity: the quote is rechecked every 5s while the invoice shows. */
export const TOPUP_POLL_INTERVAL_MS = 5000;
