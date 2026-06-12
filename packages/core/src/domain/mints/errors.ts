/**
 * Typed errors of the mints domain (`mints.*` feature map). Secret-free by
 * construction: only URLs, reasons and HTTP statuses — never request bodies
 * or auth headers.
 */
import { Data } from "effect";

/** The input cannot be a mint URL (`mints.add-custom` / `mints.select-main`). */
export class InvalidMintUrlError extends Data.TaggedError("InvalidMintUrlError")<{
  readonly url: string;
}> {}

/** `/v1/info` (and the legacy `/info`) could not be fetched or decoded. */
export class MintInfoFetchError extends Data.TaggedError("MintInfoFetchError")<{
  readonly mintUrl: string;
  readonly reason: string;
}> {}

/**
 * The hosted npub.cash-compatible service refused or never received the
 * main-mint preference update (`mints.sync-hosted`). Contract: callers MUST
 * NOT persist the local main-mint selection when they see this error.
 */
export class HostedMintSyncError extends Data.TaggedError("HostedMintSyncError")<{
  readonly url: string;
  readonly reason: string;
  /** HTTP status when the service answered, null on transport failure. */
  readonly status: number | null;
}> {}

/**
 * Melt-to-main found nothing to move: the source tokens decode to no
 * spendable proofs (`mints.melt-to-main`, issue #42).
 */
export class ConsolidationUnavailableError extends Data.TaggedError(
  "ConsolidationUnavailableError",
)<{
  readonly sourceMintUrl: string;
}> {}

/**
 * Every melt amount attempt failed with a retryable shortage and the
 * attempt cap was reached (`mints.melt-to-main` fee-retry ladder). The
 * source funds are untouched. `lastError` is a mint/wallet message string
 * (secret-free; same material as `MintProtocolError.detail`).
 */
export class ConsolidationExhaustedError extends Data.TaggedError("ConsolidationExhaustedError")<{
  readonly sourceMintUrl: string;
  readonly targetMintUrl: string;
  readonly attempts: number;
  readonly lastError: string;
}> {}
