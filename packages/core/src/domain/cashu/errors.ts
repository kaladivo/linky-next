/**
 * Typed errors for the Cashu wallet engine.
 *
 * SECRET-SAFETY CONTRACT: none of these errors may carry proof secrets,
 * blinding factors, token strings, or the wallet seed — not in their
 * payload, not in a `cause` chain. cashu-ts failures are translated through
 * {@link sanitizeCashuFailure}, which keeps only mint-provided strings
 * (error codes / detail messages) and transport reason strings, never the
 * original error object (whose request/response baggage can contain proof
 * secrets, e.g. swap inputs). `cashuWalletSecrets.test.ts` asserts this.
 */
import { HttpResponseError, MintOperationError, NetworkError } from "@cashu/cashu-ts";
import { Data } from "effect";

const MAX_DETAIL_LENGTH = 300;

const truncate = (value: string): string =>
  value.length > MAX_DETAIL_LENGTH ? `${value.slice(0, MAX_DETAIL_LENGTH)}…` : value;

/** Network-level failure talking to a mint (DNS, timeout, CORS, offline). */
export class MintConnectionError extends Data.TaggedError("MintConnectionError")<{
  readonly mintUrl: string;
  /** Transport reason string only — never the underlying error object. */
  readonly reason: string;
}> {}

/**
 * The mint answered with a NUT protocol error (`{ code, detail }`, e.g.
 * 11005 "outputs have already been signed") or a non-2xx HTTP status.
 */
export class MintProtocolError extends Data.TaggedError("MintProtocolError")<{
  readonly mintUrl: string;
  /** NUT error code when the mint provided one (e.g. 11004, 11005, 20001). */
  readonly code: number | null;
  readonly status: number | null;
  /** Mint-provided detail message (truncated). */
  readonly detail: string;
}> {}

/**
 * cashu-ts refused an operation locally (invalid inputs, unknown keyset,
 * malformed mint data, ...). Carries the library's message only.
 */
export class WalletOperationError extends Data.TaggedError("WalletOperationError")<{
  readonly mintUrl: string;
  readonly reason: string;
}> {}

/** No usable active keyset for the wallet's unit at the mint. */
export class KeysetUnavailableError extends Data.TaggedError("KeysetUnavailableError")<{
  readonly mintUrl: string;
  readonly unit: string;
}> {}

/**
 * A token string could not be parsed/encoded. Deliberately carries only a
 * coarse reason — never the offending text (it may be a mistyped secret).
 */
export class InvalidCashuTokenError extends Data.TaggedError("InvalidCashuTokenError")<{
  readonly reason: "empty" | "unparseable" | "missing-mint" | "unencodable";
}> {}

/** A token belongs to a different mint than the operation targets. */
export class WrongMintError extends Data.TaggedError("WrongMintError")<{
  readonly expectedMintUrl: string;
  readonly tokenMintUrl: string;
}> {}

/** Requested amount is not a positive integer. */
export class InvalidAmountError extends Data.TaggedError("InvalidAmountError")<{
  readonly amount: number;
}> {}

/** Spendable value at the mint does not cover the operation. */
export class InsufficientFundsError extends Data.TaggedError("InsufficientFundsError")<{
  readonly mintUrl: string;
  /** Amount needed, including fee reserve and input fees where relevant. */
  readonly required: number;
  readonly available: number;
}> {}

/** Mint quote is not in a claimable state (claimable = PAID | ISSUED). */
export class MintQuoteNotClaimableError extends Data.TaggedError("MintQuoteNotClaimableError")<{
  readonly mintUrl: string;
  readonly quoteId: string;
  readonly state: "UNPAID" | "EXPIRED" | "UNKNOWN";
}> {}

/** Union of failures any mint-touching call can produce. */
export type CashuMintFailure = MintConnectionError | MintProtocolError | WalletOperationError;

const messageOf = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "unknown error";
};

/**
 * Translates anything thrown by cashu-ts (or our injected transport) into a
 * typed, secret-free failure. The original error object is dropped on
 * purpose — see the module contract above.
 */
export const sanitizeCashuFailure = (mintUrl: string, error: unknown): CashuMintFailure => {
  if (error instanceof MintOperationError) {
    return new MintProtocolError({
      mintUrl,
      code: error.code,
      status: error.status,
      detail: truncate(error.message),
    });
  }
  if (error instanceof HttpResponseError) {
    return new MintProtocolError({
      mintUrl,
      code: null,
      status: error.status,
      detail: truncate(error.message),
    });
  }
  if (error instanceof NetworkError) {
    return new MintConnectionError({ mintUrl, reason: truncate(error.message) });
  }
  return new WalletOperationError({ mintUrl, reason: truncate(messageOf(error)) });
};

// ---------------------------------------------------------------------------
// Output-collision classification (PoC cashuErrors.ts semantics)
// ---------------------------------------------------------------------------

const detailOf = (failure: CashuMintFailure): string =>
  failure._tag === "MintProtocolError" ? failure.detail : failure.reason;

const codeOf = (failure: CashuMintFailure): number | null =>
  failure._tag === "MintProtocolError" ? failure.code : null;

/**
 * NUT error 11005 (some mints surface 11003 text): the mint has already
 * signed one of our deterministic blinded messages — the counter window
 * overlaps a previously used range.
 */
export const isOutputsAlreadySignedFailure = (failure: CashuMintFailure): boolean => {
  if (codeOf(failure) === 11005) return true;
  const message = detailOf(failure).toLowerCase();
  return (
    message.includes("outputs have already been signed") ||
    message.includes("outputs already signed") ||
    message.includes("already been signed before") ||
    message.includes("keyset id already signed")
  );
};

/**
 * NUT error 11004: one of our blinded messages matches an unsigned promise
 * the mint is still holding (orphan blank-output rows from old melts).
 */
export const isOutputsPendingFailure = (failure: CashuMintFailure): boolean => {
  if (codeOf(failure) === 11004) return true;
  const message = detailOf(failure).toLowerCase();
  return message.includes("outputs are pending") || message.includes("output is pending");
};

/** Collision the deterministic-counter retry loops can recover from. */
export const isRecoverableOutputCollision = (failure: CashuMintFailure): boolean =>
  isOutputsAlreadySignedFailure(failure) || isOutputsPendingFailure(failure);
