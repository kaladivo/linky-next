/**
 * Pure LNURL-withdraw presentation logic (`lnurl.withdraw`, issue #40).
 * No React, no storage — vitest-covered; the impure flow lives in
 * ./lnurlWithdrawActions.ts and the screen state in ./useLnurlWithdraw.ts.
 *
 * PoC parity notes (LnurlWithdrawConfirmModal + confirmLnurlWithdraw):
 * - the preview always withdraws the offer's maximum (`defaultAmountSat`);
 *   a ranged offer only adds the "maximum available amount" note;
 * - the summary line is the service `defaultDescription`, falling back to
 *   the host/path display text;
 * - error copy: mint-side quote failures read as the top-up's "failed to
 *   fetch invoice", LNURL-side failures as "LNURLw withdrawal failed" (with
 *   the service-supplied reason appended when one exists).
 */
import type { LnurlWithdrawOffer } from "@linky/core";

export type WithdrawOfferErrorKey = "lnurlWithdrawInvalidTarget" | "lnurlWithdrawLoadFailed";
export type WithdrawConfirmErrorKey = "topupInvoiceFailed" | "lnurlWithdrawFailed";

/** PoC: a ranged offer shows the "maximum available amount" note. */
export const hasVariableWithdrawAmount = (
  offer: Pick<LnurlWithdrawOffer, "minAmountSat" | "maxAmountSat">,
): boolean => offer.minAmountSat !== offer.maxAmountSat;

/** PoC: `description ?? target` is the one summary line under the amount. */
export const withdrawOfferSummary = (
  offer: Pick<LnurlWithdrawOffer, "description" | "target">,
): string => offer.description ?? offer.target;

/** Copy for a failed offer load, by core error tag. */
export const withdrawOfferErrorKey = (errorTag: string): WithdrawOfferErrorKey =>
  errorTag === "InvalidLnurlError" ? "lnurlWithdrawInvalidTarget" : "lnurlWithdrawLoadFailed";

/**
 * Mint-side failures of `withdrawViaLnurl` (top-up quote creation).
 * `CashuMintFailure` is a union type — at runtime it appears as the
 * MintConnection/MintProtocol/WalletOperation tags below.
 */
const MINT_STAGE_ERROR_TAGS: ReadonlySet<string> = new Set([
  "InvalidAmountError",
  "KeysetUnavailableError",
  "MintConnectionError",
  "MintProtocolError",
  "WalletOperationError",
]);

/** Copy for a failed confirm: quote-stage vs callback-stage errors. */
export const withdrawConfirmErrorKey = (errorTag: string): WithdrawConfirmErrorKey =>
  MINT_STAGE_ERROR_TAGS.has(errorTag) ? "topupInvoiceFailed" : "lnurlWithdrawFailed";

/** Appends the service-provided reason (if any) to translated error copy. */
export const withdrawErrorText = (message: string, reason: string | null): string =>
  reason === null || reason.trim() === "" ? message : `${message}: ${reason}`;
