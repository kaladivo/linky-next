/**
 * HTTP port — outbound HTTP for mint APIs, LNURL endpoints, npub.cash, etc.
 *
 * We do not define our own tag: the port IS `@effect/platform`'s
 * `HttpClient.HttpClient`, re-exported here so domain code imports it from
 * `@linky/core` like every other port. Failures are the typed
 * `HttpClientError` family (`RequestError` / `ResponseError`); workflows map
 * them into domain errors at their boundary.
 *
 * Usage:
 *
 * ```ts
 * import { Effect } from "effect";
 * import { HttpClient, HttpClientResponse } from "@linky/core";
 *
 * const mintInfo = (mintUrl: string) =>
 *   Effect.gen(function* () {
 *     const http = yield* HttpClient.HttpClient;
 *     const response = yield* http.get(`${mintUrl}/v1/info`);
 *     return yield* response.json;
 *   });
 * ```
 *
 * The production Layer is wired by the app (e.g. `FetchHttpClient.layer`
 * from `@effect/platform`, or a platform-tuned client); tests provide a stub
 * client built with `HttpClient.make` — no network in core tests.
 */
export {
  HttpBody,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "@effect/platform";
