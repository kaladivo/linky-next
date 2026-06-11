/**
 * Typed errors for the Lightning / LNURL domain (issue #34).
 *
 * SECRET-SAFETY: BOLT11 invoices are not secrets, but the no-secret
 * discipline still applies — errors never carry full invoice strings,
 * payment preimages, or raw HTTP error objects. LNURL failures keep only the
 * endpoint URL and a reason string.
 */
import { Data } from "effect";

const MAX_REASON_LENGTH = 300;

/** Truncates server/transport-provided strings before they enter an error. */
export const truncateReason = (value: string): string =>
  value.length > MAX_REASON_LENGTH ? `${value.slice(0, MAX_REASON_LENGTH)}…` : value;

/** Input is not a `user@domain` Lightning address. */
export class InvalidLightningAddressError extends Data.TaggedError(
  "InvalidLightningAddressError",
)<{
  readonly reason: "format";
}> {}

/** Input does not parse as a BOLT11 invoice. */
export class InvalidBolt11InvoiceError extends Data.TaggedError("InvalidBolt11InvoiceError")<{
  /** `empty` = blank input, `not-bolt11` = missing ln* HRP prefix. */
  readonly reason: "empty" | "not-bolt11";
}> {}

/** Input is not a recognizable LNURL (bech32 lnurl1…, lnurlp/lnurlw scheme, http URL). */
export class InvalidLnurlError extends Data.TaggedError("InvalidLnurlError")<{
  readonly reason: "unrecognized" | "not-pay-target" | "not-withdraw-target";
}> {}

/** Unified parser: the input matches no supported Lightning format. */
export class UnrecognizedLightningInputError extends Data.TaggedError(
  "UnrecognizedLightningInputError",
)<Record<never, never>> {}

/** Transport-level failure reaching an LNURL endpoint. */
export class LnurlConnectionError extends Data.TaggedError("LnurlConnectionError")<{
  readonly url: string;
  /** Transport reason string only — never the underlying error object. */
  readonly reason: string;
}> {}

/** The LNURL endpoint answered, but not with what the protocol requires. */
export class LnurlResponseError extends Data.TaggedError("LnurlResponseError")<{
  readonly url: string;
  /** What was wrong (non-2xx status, unparseable JSON, missing field, …). */
  readonly reason: string;
}> {}

/** The LNURL service returned `{ "status": "ERROR", "reason": … }`. */
export class LnurlStatusError extends Data.TaggedError("LnurlStatusError")<{
  readonly url: string;
  /** Service-provided reason (truncated), or a generic fallback. */
  readonly reason: string;
}> {}

/** The endpoint serves a different LNURL sub-protocol than requested. */
export class LnurlTagMismatchError extends Data.TaggedError("LnurlTagMismatchError")<{
  readonly url: string;
  readonly expected: "payRequest" | "withdrawRequest";
  /** The tag the service actually advertised ("" when absent). */
  readonly tag: string;
}> {}

/** Requested LNURL-pay amount is outside the advertised min/max range. */
export class LnurlPayAmountOutOfRangeError extends Data.TaggedError(
  "LnurlPayAmountOutOfRangeError",
)<{
  readonly amountMsat: number;
  readonly minSendableMsat: number;
  readonly maxSendableMsat: number;
}> {}

/** The invoice returned by an LNURL-pay callback does not match the request. */
export class LnurlInvoiceMismatchError extends Data.TaggedError("LnurlInvoiceMismatchError")<{
  readonly reason: "amount-mismatch" | "metadata-hash-mismatch";
  /** msat the caller asked for (amount-mismatch only). */
  readonly expectedAmountMsat: number | null;
  /** msat the invoice carries (amount-mismatch only). */
  readonly invoiceAmountMsat: number | null;
}> {}

/** Amountless invoice: the caller must supply an explicit amount (melt needs one). */
export class InvoiceAmountRequiredError extends Data.TaggedError(
  "InvoiceAmountRequiredError",
)<Record<never, never>> {}

/** Requested LNURL-withdraw amount is outside the advertised min/max range. */
export class LnurlWithdrawAmountOutOfRangeError extends Data.TaggedError(
  "LnurlWithdrawAmountOutOfRangeError",
)<{
  readonly amountSat: number;
  readonly minAmountSat: number;
  readonly maxAmountSat: number;
}> {}
