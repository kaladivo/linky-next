/**
 * Pay a Lightning address / LNURL-pay target from the Cashu wallet
 * (`lightning.pay-address` + `lnurl.pay` in the feature map):
 *
 *   resolve target → load LNURL-pay metadata → validate amount against
 *   min/max → fetch invoice from the callback (verified: amount + LUD-06
 *   metadata hash) → melt via #32's `payInvoice`, which keeps any remainder
 *   as NUT-08 change. One payment never splits across mints (enforced
 *   structurally by `payInvoice`).
 */
import { Effect } from "effect";

import type { CounterStore } from "../../ports/CounterStore.js";
import type { HttpClient } from "../../ports/index.js";
import type { CashuSeed } from "../identity/DerivedIdentities.js";
import type { PayInvoiceError, PayInvoiceResult } from "../cashu/meltToken.js";
import { payInvoice } from "../cashu/meltToken.js";
import type {
  FetchLnurlPayInvoiceError,
  FetchLnurlPayMetadataError,
  LnurlPayMetadata,
  LnurlSuccessAction,
} from "./lnurlPay.js";
import { fetchLnurlPayInvoice, fetchLnurlPayMetadata } from "./lnurlPay.js";

export interface PayLightningAddressArgs {
  readonly seed: CashuSeed;
  /** The single mint funding this payment. */
  readonly mintUrl: string;
  /** Stored token strings to fund the payment — all at `mintUrl`. */
  readonly tokens: ReadonlyArray<string>;
  /** Lightning address (`user@domain`) or any LNURL-pay target. */
  readonly target: string;
  readonly amountSat: number;
  /** Optional LUD-12 comment (e.g. the sender's display name). */
  readonly comment?: string | undefined;
  readonly unit?: string | undefined;
}

export interface PayLightningAddressResult {
  /** The melt outcome — fees, preimage, preserved change. */
  readonly payment: PayInvoiceResult;
  /** The (verified) invoice that was paid. */
  readonly invoice: string;
  readonly metadata: LnurlPayMetadata;
  readonly successAction: LnurlSuccessAction | null;
}

export type PayLightningAddressError =
  | FetchLnurlPayMetadataError
  | FetchLnurlPayInvoiceError
  | PayInvoiceError;

export const payLightningAddress = (
  args: PayLightningAddressArgs,
): Effect.Effect<
  PayLightningAddressResult,
  PayLightningAddressError,
  HttpClient.HttpClient | CounterStore
> =>
  Effect.gen(function* () {
    const metadata = yield* fetchLnurlPayMetadata(args.target);
    const { invoice, successAction } = yield* fetchLnurlPayInvoice({
      metadata,
      amountSat: args.amountSat,
      comment: args.comment,
    });
    const payment = yield* payInvoice({
      seed: args.seed,
      mintUrl: args.mintUrl,
      invoice,
      tokens: args.tokens,
      unit: args.unit,
    });
    return { payment, invoice, metadata, successAction };
  });
