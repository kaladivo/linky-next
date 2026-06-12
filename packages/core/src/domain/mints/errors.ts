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
