/**
 * LNURL-withdraw flow actions (`lnurl.withdraw`, issue #40) — the impure
 * seam over core's #34 workflow: load the offer preview, and on confirm run
 * `withdrawViaLnurl` (top-up mint quote + callback submit) and record the
 * accepted quote as a standard pending top-up transaction row.
 *
 * Recording reuses #37's shape verbatim (category "lightning", method
 * "invoice", quote payload in `detailsJson`) ON PURPOSE: the withdraw's
 * receive leg IS a top-up — the shared poll/claim loop, the receive
 * screen's resume affordance and the invoice screen's re-claim-on-reopen
 * all apply to it unchanged. Only the `phase` breadcrumb differs.
 *
 * Error shape: typed workflow errors map to plain outcome values (the
 * topupActions convention) — screens render outcomes, never Effect errors.
 * Repository write failures on app-controlled values are bugs → thrown.
 */
import type { LnurlWithdrawOffer } from "@linky/core";
import { fetchLnurlWithdrawOffer, withdrawViaLnurl } from "@linky/core";
import type { LinkyStore } from "@linky/evolu-store";
import { createTransactionsRepository } from "@linky/evolu-store";
import { Effect } from "effect";

import { runAppEffect } from "../runtime";
import { invalidateStoreData } from "../store/storeManager";
import { resolveTopupMintUrl } from "./topupActions";
import type { PendingTopup } from "./topupActions";
import {
  TOPUP_TRANSACTION_CATEGORY,
  TOPUP_TRANSACTION_METHOD,
  pendingQuoteFromTopupQuote,
  serializePendingTopupQuote,
} from "./topupQuote";

export type WithdrawOfferOutcome =
  | { readonly kind: "ready"; readonly offer: LnurlWithdrawOffer }
  | {
      readonly kind: "failed";
      readonly errorTag: string;
      /** Service-provided reason (LnurlStatusError only). */
      readonly reason: string | null;
    };

/** Loads and validates the withdraw offer (the preview step). */
export const loadLnurlWithdrawOffer = (target: string): Promise<WithdrawOfferOutcome> =>
  runAppEffect(
    fetchLnurlWithdrawOffer(target).pipe(
      Effect.map((offer) => ({ kind: "ready", offer }) as const),
      Effect.catchAll((error) =>
        Effect.succeed({
          kind: "failed",
          errorTag: error._tag,
          reason: error._tag === "LnurlStatusError" ? error.reason : null,
        } as const),
      ),
    ),
  );

export type WithdrawConfirmOutcome =
  /** Callback accepted the invoice; the service pays it asynchronously. */
  | { readonly kind: "submitted"; readonly pending: PendingTopup }
  | {
      readonly kind: "failed";
      readonly errorTag: string;
      /** Service-provided reason (LnurlStatusError only). */
      readonly reason: string | null;
    };

/**
 * Executes a confirmed withdraw at the offer's default amount (= maximum
 * withdrawable, PoC parity) into the main mint, and records the accepted
 * quote as a pending top-up row for the shared poll/claim machinery.
 */
export const confirmLnurlWithdraw = async (
  store: LinkyStore,
  offer: LnurlWithdrawOffer,
): Promise<WithdrawConfirmOutcome> => {
  const nowMs = Date.now();
  const mintUrl = await resolveTopupMintUrl(store);

  const outcome = await runAppEffect(
    withdrawViaLnurl({ mintUrl, offer }).pipe(
      Effect.map((result) => ({ ok: true, result }) as const),
      Effect.catchAll((error) =>
        Effect.succeed({
          ok: false,
          errorTag: error._tag,
          reason: error._tag === "LnurlStatusError" ? error.reason : null,
        } as const),
      ),
    ),
  );
  if (!outcome.ok) {
    return { kind: "failed", errorTag: outcome.errorTag, reason: outcome.reason };
  }

  const quote = pendingQuoteFromTopupQuote(outcome.result.quote, nowMs);
  const recorded = createTransactionsRepository(store).record({
    happenedAtSec: Math.max(1, Math.floor(nowMs / 1000)),
    direction: "in",
    status: "pending",
    category: TOPUP_TRANSACTION_CATEGORY,
    method: TOPUP_TRANSACTION_METHOD,
    phase: "withdraw-accepted",
    amount: quote.amountSat,
    unit: quote.unit,
    mintUrl: quote.mintUrl,
    detailsJson: serializePendingTopupQuote(quote),
  });
  if (!recorded.ok) {
    throw new Error(`record withdraw transaction failed: ${recorded.error._tag}`);
  }
  invalidateStoreData();
  return { kind: "submitted", pending: { transactionId: recorded.value.id, quote } };
};
