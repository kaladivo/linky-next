/**
 * LNURL JSON-over-HTTP helper (internal). All LNURL traffic goes through the
 * HttpClient port; failures become typed, secret-free errors:
 *
 * - transport failure → `LnurlConnectionError` (reason string only),
 * - non-2xx / unparseable JSON → `LnurlResponseError`,
 * - `{ "status": "ERROR" }` body → `LnurlStatusError` with the service reason.
 *
 * The PoC additionally proxied browser-CORS-blocked requests through
 * `app.linky.fit/api/lnurlp`; that workaround is web-only and intentionally
 * not ported (React Native has no CORS).
 */
import { Effect } from "effect";

import { HttpClient } from "../../../ports/index.js";
import { LnurlConnectionError, LnurlResponseError, LnurlStatusError, truncateReason } from "../errors.js";

export const isJsonRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const asNonEmptyString = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
};

export const asOptionalNumber = (value: unknown): number | null => {
  const parsed = Number(value ?? NaN);
  return Number.isFinite(parsed) ? parsed : null;
};

/** GETs `url` and returns the parsed JSON record, ERROR status pre-checked. */
export const getLnurlJson = (
  url: string,
): Effect.Effect<
  Record<string, unknown>,
  LnurlConnectionError | LnurlResponseError | LnurlStatusError,
  HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const response = yield* http
      .get(url)
      .pipe(
        Effect.mapError(
          (error) => new LnurlConnectionError({ url, reason: truncateReason(error.reason) }),
        ),
      );

    const json = yield* response.json.pipe(
      Effect.mapError(() => new LnurlResponseError({ url, reason: "unparseable JSON body" })),
    );

    if (!isJsonRecord(json)) {
      return yield* Effect.fail(new LnurlResponseError({ url, reason: "body is not an object" }));
    }

    // LUD-protocol errors are reported in the body (often with 2xx, sometimes
    // with 4xx) — check the body's status field before the HTTP status.
    if (String(json["status"] ?? "").toUpperCase() === "ERROR") {
      const reason = asNonEmptyString(json["reason"]);
      return yield* Effect.fail(
        new LnurlStatusError({ url, reason: reason === null ? "LNURL error" : truncateReason(reason) }),
      );
    }

    if (response.status < 200 || response.status >= 300) {
      return yield* Effect.fail(
        new LnurlResponseError({ url, reason: `HTTP ${String(response.status)}` }),
      );
    }

    return json;
  });
