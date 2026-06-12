/**
 * Test kit for the mints domain (test-only, excluded from the build): an
 * HttpClient Layer that scripts JSON responses by URL prefix and CAPTURES
 * every request (method, url, headers, body bytes) so tests can assert the
 * hosted-sync wire format byte-for-byte.
 */
import { Effect, Layer } from "effect";

import { HttpClient, HttpClientError, HttpClientResponse } from "../../../ports/index.js";

export interface CapturedRequest {
  readonly method: string;
  readonly url: string;
  /** Lowercase header names (as @effect/platform stores them). */
  readonly headers: Readonly<Record<string, string>>;
  /** UTF-8 decoded body for Uint8Array bodies, null otherwise. */
  readonly bodyText: string | null;
  /** Content type attached to the body, if any. */
  readonly bodyContentType: string | null;
}

export interface StubResponse {
  readonly status: number;
  readonly body: unknown;
}

/** `status: -1` simulates a transport failure (typed `RequestError`). */
export type MintsRoute = readonly [urlPrefix: string, handler: () => StubResponse];

export interface MintsHttpStub {
  readonly layer: Layer.Layer<HttpClient.HttpClient>;
  readonly requests: CapturedRequest[];
}

/** Routes matched by URL prefix (first match wins); unmatched → 404. */
export const mintsHttpStub = (routes: ReadonlyArray<MintsRoute>): MintsHttpStub => {
  const requests: CapturedRequest[] = [];

  const layer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.suspend(() => {
        const body = request.body as {
          readonly _tag?: string;
          readonly body?: unknown;
          readonly contentType?: string;
        };
        const bodyText =
          body._tag === "Uint8Array" && body.body instanceof Uint8Array
            ? new TextDecoder().decode(body.body)
            : null;
        requests.push({
          method: request.method,
          url: request.url,
          headers: { ...request.headers },
          bodyText,
          bodyContentType: body._tag === "Uint8Array" ? (body.contentType ?? null) : null,
        });

        for (const [prefix, handler] of routes) {
          if (request.url.startsWith(prefix)) {
            const stub = handler();
            if (stub.status < 0) {
              return Effect.fail(
                new HttpClientError.RequestError({
                  request,
                  reason: "Transport",
                  description: "stubbed transport failure",
                }),
              );
            }
            return Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                new Response(JSON.stringify(stub.body), {
                  status: stub.status,
                  headers: { "content-type": "application/json" },
                }),
              ),
            );
          }
        }
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(JSON.stringify({ error: `no stub for ${request.url}` }), {
              status: 404,
            }),
          ),
        );
      }),
    ),
  );

  return { layer, requests };
};

export const ok = (body: unknown): StubResponse => ({ status: 200, body });
