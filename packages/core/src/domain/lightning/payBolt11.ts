/**
 * Pay a BOLT11 invoice from the Cashu wallet (`lightning.pay-invoice`,
 * `lightning.confirm-invoice`, `lightning.autopay-limit` in the feature map).
 *
 * The auto-pay limit itself is a user setting owned by #39's UI; this module
 * defines the CONTRACT: a pure predicate over the parsed invoice and an
 * {@link AutoPaySetting}. The PoC rule (`useScannedTextHandler`): auto-pay
 * exactly when enabled AND the invoice has an amount AND that amount is at
 * or below the limit. Amountless or unparseable-amount invoices always need
 * confirmation.
 */
import { Effect } from "effect";

import type { CounterStore } from "../../ports/CounterStore.js";
import type { HttpClient } from "../../ports/index.js";
import type { CashuSeed } from "../identity/DerivedIdentities.js";
import type { PayInvoiceError, PayInvoiceResult } from "../cashu/meltToken.js";
import { payInvoice } from "../cashu/meltToken.js";
import type { Bolt11Invoice } from "./bolt11.js";
import { parseBolt11Invoice } from "./bolt11.js";
import type { InvalidBolt11InvoiceError } from "./errors.js";
import { InvoiceAmountRequiredError } from "./errors.js";

// ---------------------------------------------------------------------------
// Auto-pay limit contract (consumed by #39's settings UI)
// ---------------------------------------------------------------------------

export interface AutoPaySetting {
  /** Auto-pay is on by default in the product; #39 stores the user's choice. */
  readonly enabled: boolean;
  /** Inclusive upper bound in sat for confirmation-free payments. */
  readonly limitSat: number;
}

export type AutoPayDecision = "auto-pay" | "needs-confirmation";

/** Pure predicate — the hook #39 feeds with the persisted setting. */
export const decideAutoPay = (
  invoice: Pick<Bolt11Invoice, "amountSat">,
  setting: AutoPaySetting,
): AutoPayDecision =>
  setting.enabled &&
  invoice.amountSat !== null &&
  Number.isFinite(setting.limitSat) &&
  invoice.amountSat <= setting.limitSat
    ? "auto-pay"
    : "needs-confirmation";

// ---------------------------------------------------------------------------
// Pay workflow
// ---------------------------------------------------------------------------

export interface PayBolt11InvoiceArgs {
  readonly seed: CashuSeed;
  /** The single mint funding this payment. */
  readonly mintUrl: string;
  /** Stored token strings to fund the payment — all at `mintUrl`. */
  readonly tokens: ReadonlyArray<string>;
  /** BOLT11 invoice text (`lightning:` prefix tolerated). */
  readonly invoice: string;
  readonly unit?: string | undefined;
}

export interface PayBolt11InvoiceResult {
  readonly payment: PayInvoiceResult;
  readonly invoice: Bolt11Invoice;
}

export type PayBolt11InvoiceError =
  | InvalidBolt11InvoiceError
  | InvoiceAmountRequiredError
  | PayInvoiceError;

/**
 * Parses and pays a BOLT11 invoice via melt (NUT-05), from a single mint,
 * preserving any remainder as change. Amountless invoices are rejected with
 * {@link InvoiceAmountRequiredError}: a melt quote prices the invoice itself,
 * so the UI must collect an amount and obtain an amounted invoice instead
 * (mint support for amountless melts is not assumed).
 */
export const payBolt11Invoice = (
  args: PayBolt11InvoiceArgs,
): Effect.Effect<
  PayBolt11InvoiceResult,
  PayBolt11InvoiceError,
  HttpClient.HttpClient | CounterStore
> =>
  Effect.gen(function* () {
    const invoice = yield* parseBolt11Invoice(args.invoice);
    if (invoice.amountMsat === null) {
      return yield* Effect.fail(new InvoiceAmountRequiredError());
    }
    const payment = yield* payInvoice({
      seed: args.seed,
      mintUrl: args.mintUrl,
      invoice: invoice.invoice,
      tokens: args.tokens,
      unit: args.unit,
    });
    return { payment, invoice };
  });
