/**
 * DeepLinks port — URLs that open the app: the launch URL (cold start) and
 * URLs delivered while the app is already running (`linky-dev://...`,
 * `lightning:`, `cashu:`, universal links). Implementations live in
 * `packages/platform` (backed by `expo-linking`).
 *
 * URLs cross this port as raw strings; parsing/routing them into app intents
 * is a domain concern that happens on the other side.
 */
import { Context, Data } from "effect";
import type { Effect, Option, Stream } from "effect";

/**
 * Expected failure while reading the launch URL (bridge error). The live URL
 * stream itself does not fail: a broken subscription is a programmer error,
 * not an expected runtime condition.
 */
export class DeepLinksError extends Data.TaggedError("DeepLinksError")<{
  readonly cause?: unknown;
}> {}

export interface DeepLinksService {
  /**
   * The URL the app was launched with, if any. `Option.none()` for a normal
   * (non-link) launch.
   */
  readonly initialUrl: Effect.Effect<Option.Option<string>, DeepLinksError>;
  /**
   * Stream of URLs delivered while the app is running. Subscription starts
   * when the stream is consumed and is torn down when the consumer stops;
   * each consumer gets its own subscription. Does not replay the initial URL.
   */
  readonly urls: Stream.Stream<string>;
}

export class DeepLinks extends Context.Tag("@linky/core/DeepLinks")<
  DeepLinks,
  DeepLinksService
>() {}
