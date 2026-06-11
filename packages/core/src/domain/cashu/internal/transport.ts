/**
 * Mint transport — wires cashu-ts's network access into the HttpClient port.
 *
 * cashu-ts performs its own `fetch` by default, which would be a side effect
 * outside our ports. Its `CashuMint` constructor accepts a custom request
 * implementation (`typeof request` from cashu-ts), so we inject one built on
 * `@effect/platform` `HttpClient` — the sanctioned decision for #32: ALL
 * mint traffic flows through the HttpClient port (tests provide a fake-mint
 * HttpClient Layer; production wires FetchHttpClient). No code in this
 * package calls fetch directly.
 *
 * The injected function reproduces cashu-ts's native error mapping
 * (`NetworkError` / `HttpResponseError` / `MintOperationError`) so wallet
 * internals and our collision matchers behave exactly as with the built-in
 * transport.
 *
 * SECRET-SAFETY: HttpClient errors can reference the originating request,
 * whose body may contain proof secrets (swap/melt inputs). Only the error's
 * tag/reason strings are kept; the error object itself is dropped.
 */
import type { CashuMint } from "@cashu/cashu-ts";
import { HttpResponseError, MintOperationError, NetworkError } from "@cashu/cashu-ts";
import { Effect, Either, Runtime } from "effect";

import { HttpClient, HttpClientRequest, type HttpClientError } from "../../../ports/index.js";

/** The request-function type cashu-ts accepts (2nd CashuMint ctor arg). */
export type MintRequestFn = NonNullable<ConstructorParameters<typeof CashuMint>[1]>;

const describeHttpClientError = (error: HttpClientError.HttpClientError): string => {
  // RequestError/ResponseError both expose `reason` and an optional
  // human-readable description; we keep only those strings.
  const description = "description" in error && typeof error.description === "string"
    ? `: ${error.description}`
    : "";
  return `${error._tag} (${String(error.reason)})${description}`;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/**
 * Builds the cashu-ts-compatible request function from the HttpClient in
 * context. The returned function is a plain async function (cashu-ts calls
 * it imperatively) that runs each request on the captured runtime.
 */
export const makeMintRequest: Effect.Effect<MintRequestFn, never, HttpClient.HttpClient> =
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const runtime = yield* Effect.runtime<never>();
    const runPromise = Runtime.runPromise(runtime);

    const request = async (options: {
      endpoint: string;
      requestBody?: Record<string, unknown>;
      headers?: Record<string, string>;
      method?: string;
    }): Promise<unknown> => {
      const method = String(
        options.method ?? (options.requestBody ? "POST" : "GET"),
      ).toUpperCase();

      let httpRequest = HttpClientRequest.make(method as "GET" | "POST")(
        options.endpoint,
      ).pipe(
        HttpClientRequest.setHeaders({
          Accept: "application/json, text/plain, */*",
          ...options.headers,
        }),
      );
      if (options.requestBody !== undefined) {
        httpRequest = HttpClientRequest.bodyUnsafeJson(options.requestBody)(httpRequest);
      }

      const result = await runPromise(
        client.execute(httpRequest).pipe(
          Effect.flatMap((response) =>
            response.text.pipe(Effect.map((text) => ({ status: response.status, text }))),
          ),
          Effect.scoped,
          Effect.either,
        ),
      );

      if (Either.isLeft(result)) {
        throw new NetworkError(describeHttpClientError(result.left));
      }

      const { status, text } = result.right;
      if (status < 200 || status >= 300) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = { error: "bad response" };
        }
        if (
          status === 400 &&
          isRecord(parsed) &&
          typeof parsed["code"] === "number" &&
          typeof parsed["detail"] === "string"
        ) {
          throw new MintOperationError(parsed["code"], parsed["detail"]);
        }
        let message = "HTTP request failed";
        if (isRecord(parsed) && typeof parsed["error"] === "string") message = parsed["error"];
        else if (isRecord(parsed) && typeof parsed["detail"] === "string")
          message = parsed["detail"];
        throw new HttpResponseError(message, status);
      }

      if (text === "") return null;
      try {
        return JSON.parse(text);
      } catch {
        throw new HttpResponseError("bad response", status);
      }
    };

    return request as MintRequestFn;
  });
