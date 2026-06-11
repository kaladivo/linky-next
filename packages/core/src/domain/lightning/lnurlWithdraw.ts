/**
 * LNURL-withdraw (LUD-03) — `lnurl.withdraw` in the feature map. Receiving
 * over Lightning mints ecash: the withdraw amount is requested as a top-up
 * mint quote (#32 `createTopupQuote`), the quote's invoice is handed to the
 * LNURL-withdraw callback (`k1` + `pr`), and once the service pays it the
 * caller claims the proofs with #32's `checkTopupQuote` / `claimTopup`.
 *
 * Offer semantics match the PoC's `fetchLnurlWithdrawPreview`: a response
 * "looks like" a withdraw request when callback+k1+min+max are present even
 * without a `tag` (an explicit foreign tag fails with
 * `LnurlTagMismatchError` so scanners can fall back to LNURL-pay);
 * min/max floor msat → sat and must stay positive; the suggested amount is
 * the maximum withdrawable.
 */
import { Effect } from "effect";

import type { HttpClient } from "../../ports/index.js";
import type {
  CashuMintFailure,
  InvalidAmountError,
  KeysetUnavailableError,
} from "../cashu/errors.js";
import type { TopupQuote } from "../cashu/topup.js";
import { createTopupQuote } from "../cashu/topup.js";
import type {
  InvalidLnurlError,
  LnurlConnectionError,
  LnurlStatusError,
} from "./errors.js";
import {
  LnurlResponseError,
  LnurlTagMismatchError,
  LnurlWithdrawAmountOutOfRangeError,
} from "./errors.js";
import { appendQueryParams } from "./internal/httpUrl.js";
import { asNonEmptyString, asOptionalNumber, getLnurlJson } from "./internal/lnurlHttp.js";
import { lnurlDisplayText, resolveLnurlWithdrawUrl } from "./lnurl.js";

export interface LnurlWithdrawOffer {
  /** The LNURL-withdraw endpoint the offer came from. */
  readonly requestUrl: string;
  /** Callback the invoice is submitted to. */
  readonly callback: string;
  /** Opaque secret identifying this withdraw request at the service. */
  readonly k1: string;
  readonly minAmountSat: number;
  readonly maxAmountSat: number;
  /** Suggested amount — the maximum withdrawable (PoC default). */
  readonly defaultAmountSat: number;
  /** Service-provided `defaultDescription`. */
  readonly description: string | null;
  /** Display text for the source (host/path). */
  readonly target: string;
}

export type FetchLnurlWithdrawOfferError =
  | InvalidLnurlError
  | LnurlConnectionError
  | LnurlResponseError
  | LnurlStatusError
  | LnurlTagMismatchError;

/** Loads and validates an LNURL-withdraw offer (the preview step). */
export const fetchLnurlWithdrawOffer = (
  target: string,
): Effect.Effect<LnurlWithdrawOffer, FetchLnurlWithdrawOfferError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const requestUrl = yield* resolveLnurlWithdrawUrl(target);
    const json = yield* getLnurlJson(requestUrl);
    const invalid = (reason: string) => new LnurlResponseError({ url: requestUrl, reason });

    const tag = String(json["tag"] ?? "").trim();
    const callback = asNonEmptyString(json["callback"]);
    const k1 = asNonEmptyString(json["k1"]);
    const minWithdrawable = asOptionalNumber(json["minWithdrawable"]);
    const maxWithdrawable = asOptionalNumber(json["maxWithdrawable"]);

    const looksLikeWithdrawRequest =
      callback !== null && k1 !== null && minWithdrawable !== null && maxWithdrawable !== null;
    if (!looksLikeWithdrawRequest && tag.toLowerCase() !== "withdrawrequest") {
      return yield* Effect.fail(
        new LnurlTagMismatchError({ url: requestUrl, expected: "withdrawRequest", tag }),
      );
    }

    if (callback === null) return yield* Effect.fail(invalid("callback missing"));
    if (k1 === null) return yield* Effect.fail(invalid("k1 missing"));
    if (minWithdrawable === null || maxWithdrawable === null) {
      return yield* Effect.fail(invalid("minWithdrawable/maxWithdrawable missing"));
    }

    const minAmountSat = Math.floor(minWithdrawable / 1000);
    const maxAmountSat = Math.floor(maxWithdrawable / 1000);
    if (minAmountSat <= 0 || maxAmountSat <= 0 || maxAmountSat < minAmountSat) {
      return yield* Effect.fail(invalid("invalid withdraw amount range"));
    }

    return {
      requestUrl,
      callback,
      k1,
      minAmountSat,
      maxAmountSat,
      defaultAmountSat: maxAmountSat,
      description: asNonEmptyString(json["defaultDescription"]),
      target: lnurlDisplayText(requestUrl),
    };
  });

export interface WithdrawViaLnurlArgs {
  /** Mint that will receive the withdrawn value as ecash. */
  readonly mintUrl: string;
  readonly offer: LnurlWithdrawOffer;
  /** Defaults to the offer's `defaultAmountSat` (= max withdrawable). */
  readonly amountSat?: number | undefined;
  readonly unit?: string | undefined;
}

export interface WithdrawViaLnurlResult {
  readonly amountSat: number;
  /**
   * The top-up quote whose invoice the service accepted. The service pays it
   * asynchronously — poll with #32's `checkTopupQuote` and claim the proofs
   * with `claimTopup` once `claimable`.
   */
  readonly quote: TopupQuote;
}

export type WithdrawViaLnurlError =
  | LnurlWithdrawAmountOutOfRangeError
  | InvalidAmountError
  | KeysetUnavailableError
  | CashuMintFailure
  | LnurlConnectionError
  | LnurlResponseError
  | LnurlStatusError;

/**
 * Executes a confirmed LNURL-withdraw: mints a top-up invoice for the chosen
 * amount and submits it to the withdraw callback.
 */
export const withdrawViaLnurl = (
  args: WithdrawViaLnurlArgs,
): Effect.Effect<WithdrawViaLnurlResult, WithdrawViaLnurlError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const { offer } = args;
    const amountSat = args.amountSat ?? offer.defaultAmountSat;
    if (
      !Number.isInteger(amountSat) ||
      amountSat < offer.minAmountSat ||
      amountSat > offer.maxAmountSat
    ) {
      return yield* Effect.fail(
        new LnurlWithdrawAmountOutOfRangeError({
          amountSat,
          minAmountSat: offer.minAmountSat,
          maxAmountSat: offer.maxAmountSat,
        }),
      );
    }

    const quote = yield* createTopupQuote({
      mintUrl: args.mintUrl,
      amount: amountSat,
      unit: args.unit,
      description: offer.description ?? undefined,
    });

    const callbackUrl = appendQueryParams(offer.callback, [
      ["k1", offer.k1],
      ["pr", quote.invoice],
    ]);
    // Success is any non-ERROR JSON response (PoC checks only the status
    // field); the actual payment lands on the quote asynchronously.
    yield* getLnurlJson(callbackUrl);

    return { amountSat, quote };
  });
