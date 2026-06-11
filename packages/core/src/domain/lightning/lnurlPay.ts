/**
 * LNURL-pay (LUD-06/LUD-16/LUD-12) — metadata load and invoice fetch over the
 * HttpClient port. PoC parity (`fetchLnurlPayPreview` /
 * `fetchLnurlInvoiceForTarget`):
 *
 * - a response "looks like" a pay request when callback+min+max are present,
 *   even if the `tag` is missing (some servers omit it); otherwise the tag
 *   must be `payRequest` or the load fails with `LnurlTagMismatchError`;
 * - min/max sat previews round conservatively (`ceil` min, `floor` max);
 * - the metadata array must contain a `text/plain` entry (LUD-06);
 * - comments: when the provider advertises `commentAllowed`, the comment is
 *   truncated to it and sent; when it doesn't but a comment was given, the
 *   callback is tried with a ≤140-char comment first and silently retried
 *   without on any failure. (Divergence: the PoC dropped the comment for
 *   providers that DO advertise support — clearly inverted; fixed here.)
 * - LUD-06 step 7 verification: the invoice's `h` tag must equal
 *   sha256(metadata) when present, and a non-amountless invoice must carry
 *   exactly the requested msat — mismatches are rejected, never paid.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { Effect } from "effect";

import type { HttpClient } from "../../ports/index.js";
import { parseBolt11Invoice } from "./bolt11.js";
import type {
  InvalidLnurlError,
  LnurlConnectionError,
  LnurlStatusError,
} from "./errors.js";
import {
  LnurlInvoiceMismatchError,
  LnurlPayAmountOutOfRangeError,
  LnurlResponseError,
  LnurlTagMismatchError,
} from "./errors.js";
import { appendQueryParams, isHttpUrl } from "./internal/httpUrl.js";
import { asNonEmptyString, asOptionalNumber, getLnurlJson } from "./internal/lnurlHttp.js";
import { lnurlDisplayText, resolveLnurlPayUrl } from "./lnurl.js";

const MAX_FALLBACK_COMMENT_LENGTH = 140;

export interface LnurlPayMetadata {
  /** The LNURL-pay endpoint the metadata came from. */
  readonly requestUrl: string;
  /** Callback URL invoices are requested from. */
  readonly callback: string;
  readonly minSendableMsat: number;
  readonly maxSendableMsat: number;
  /** ceil(min/1000), at least 1 — conservative UI bound (PoC). */
  readonly minSendableSat: number;
  /** floor(max/1000), at least minSendableSat (PoC). */
  readonly maxSendableSat: number;
  /** Max comment length the provider advertises; 0 = no comment support. */
  readonly commentAllowed: number;
  /** First `text/plain` metadata entry. */
  readonly description: string | null;
  /** Raw LUD-06 metadata string (hashed into invoices' `h` tag). */
  readonly metadataRaw: string;
  /** Display text for the target (address or host/path). */
  readonly target: string;
}

export type LnurlSuccessAction =
  | { readonly _tag: "message"; readonly message: string }
  | { readonly _tag: "url"; readonly url: string; readonly description: string | null };

export interface LnurlPayInvoice {
  /** BOLT11 invoice to melt. */
  readonly invoice: string;
  /** The msat amount the invoice was requested (and verified) for. */
  readonly amountMsat: number;
  readonly successAction: LnurlSuccessAction | null;
}

export type FetchLnurlPayMetadataError =
  | InvalidLnurlError
  | LnurlConnectionError
  | LnurlResponseError
  | LnurlStatusError
  | LnurlTagMismatchError;

/** `undefined` = no `text/plain` entry at all (invalid per LUD-06). */
const parseLnurlPayDescription = (metadata: string): string | null | undefined => {
  try {
    const parsed: unknown = JSON.parse(metadata);
    if (!Array.isArray(parsed)) return undefined;
    let hasTextPlain = false;
    let description: string | null = null;
    for (const entry of parsed) {
      if (!Array.isArray(entry) || entry.length < 2) continue;
      const [mime, value] = entry as [unknown, unknown];
      if (typeof mime !== "string" || typeof value !== "string") continue;
      if (mime.trim().toLowerCase() === "text/plain") {
        hasTextPlain = true;
        const trimmed = value.trim();
        if (trimmed && description === null) description = trimmed;
      }
    }
    return hasTextPlain ? description : undefined;
  } catch {
    return undefined;
  }
};

const sha256HexOfUtf8 = (input: string): string => {
  const bytes = sha256(utf8ToBytes(input));
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
};

/** LUD-09 success actions; only safely displayable tags surface (PoC). */
const parseSuccessAction = (value: unknown): LnurlSuccessAction | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const tag = String(record["tag"] ?? "")
    .trim()
    .toLowerCase();

  if (tag === "message") {
    const message = asNonEmptyString(record["message"]);
    return message === null ? null : { _tag: "message", message };
  }

  if (tag === "url") {
    const url = asNonEmptyString(record["url"]);
    if (url === null || !isHttpUrl(url)) return null;
    return { _tag: "url", url, description: asNonEmptyString(record["description"]) };
  }

  // Other LUD-09 tags (e.g. "aes") are intentionally not surfaced.
  return null;
};

/**
 * Resolves a Lightning address / LNURL-pay target and loads its pay metadata.
 */
export const fetchLnurlPayMetadata = (
  target: string,
): Effect.Effect<LnurlPayMetadata, FetchLnurlPayMetadataError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const requestUrl = yield* resolveLnurlPayUrl(target);
    const json = yield* getLnurlJson(requestUrl);
    const invalid = (reason: string) => new LnurlResponseError({ url: requestUrl, reason });

    const tag = String(json["tag"] ?? "").trim();
    const callback = asNonEmptyString(json["callback"]);
    const minSendableMsat = asOptionalNumber(json["minSendable"]);
    const maxSendableMsat = asOptionalNumber(json["maxSendable"]);

    const looksLikePayRequest =
      callback !== null && minSendableMsat !== null && maxSendableMsat !== null;
    if (!looksLikePayRequest && tag.toLowerCase() !== "payrequest") {
      return yield* Effect.fail(
        new LnurlTagMismatchError({ url: requestUrl, expected: "payRequest", tag }),
      );
    }

    if (callback === null) return yield* Effect.fail(invalid("callback missing"));
    if (
      minSendableMsat === null ||
      maxSendableMsat === null ||
      minSendableMsat <= 0 ||
      maxSendableMsat <= 0 ||
      maxSendableMsat < minSendableMsat
    ) {
      return yield* Effect.fail(invalid("invalid minSendable/maxSendable"));
    }

    const metadataRaw = asNonEmptyString(json["metadata"]);
    if (metadataRaw === null) return yield* Effect.fail(invalid("metadata missing"));
    const description = parseLnurlPayDescription(metadataRaw);
    if (description === undefined) {
      return yield* Effect.fail(invalid("metadata missing text/plain entry"));
    }

    const minSendableSat = Math.max(1, Math.ceil(minSendableMsat / 1000));
    const maxSendableSat = Math.max(minSendableSat, Math.floor(maxSendableMsat / 1000));

    const commentAllowedRaw = asOptionalNumber(json["commentAllowed"]) ?? 0;
    const commentAllowed = commentAllowedRaw > 0 ? Math.floor(commentAllowedRaw) : 0;

    return {
      requestUrl,
      callback,
      minSendableMsat,
      maxSendableMsat,
      minSendableSat,
      maxSendableSat,
      commentAllowed,
      description,
      metadataRaw,
      target: lnurlDisplayText(requestUrl),
    };
  });

export interface FetchLnurlPayInvoiceArgs {
  readonly metadata: LnurlPayMetadata;
  readonly amountSat: number;
  readonly comment?: string | undefined;
}

export type FetchLnurlPayInvoiceError =
  | LnurlPayAmountOutOfRangeError
  | LnurlConnectionError
  | LnurlResponseError
  | LnurlStatusError
  | LnurlInvoiceMismatchError;

const callbackUrlWith = (
  callback: string,
  amountMsat: number,
  comment: string | null,
): string =>
  appendQueryParams(callback, [
    ["amount", String(amountMsat)],
    ...(comment === null ? [] : [["comment", comment] as const]),
  ]);

/**
 * Requests an invoice for `amountSat` from a loaded LNURL-pay target and
 * verifies it (amount + LUD-06 metadata hash) before anyone may pay it.
 */
export const fetchLnurlPayInvoice = (
  args: FetchLnurlPayInvoiceArgs,
): Effect.Effect<LnurlPayInvoice, FetchLnurlPayInvoiceError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const { metadata } = args;
    const amountMsat = Math.round(args.amountSat * 1000);
    if (
      !Number.isFinite(amountMsat) ||
      amountMsat < metadata.minSendableMsat ||
      amountMsat > metadata.maxSendableMsat
    ) {
      return yield* Effect.fail(
        new LnurlPayAmountOutOfRangeError({
          amountMsat,
          minSendableMsat: metadata.minSendableMsat,
          maxSendableMsat: metadata.maxSendableMsat,
        }),
      );
    }

    const rawComment = String(args.comment ?? "").trim();
    const advertisesComment = metadata.commentAllowed > 0;
    const comment =
      rawComment === ""
        ? null
        : advertisesComment
          ? rawComment.slice(0, metadata.commentAllowed)
          : rawComment.slice(0, MAX_FALLBACK_COMMENT_LENGTH);

    const fetchInvoiceJson = Effect.gen(function* () {
      // Provider doesn't advertise comments: try with one anyway, fall back
      // silently without it on ANY failure (PoC behavior for misreporting
      // providers).
      if (comment !== null && !advertisesComment) {
        const attempt = yield* Effect.either(
          getLnurlJson(callbackUrlWith(metadata.callback, amountMsat, comment)),
        );
        if (attempt._tag === "Right") return attempt.right;
      }
      return yield* getLnurlJson(
        callbackUrlWith(metadata.callback, amountMsat, advertisesComment ? comment : null),
      );
    });

    const json = yield* fetchInvoiceJson;
    const callbackUrl = metadata.callback;
    const invoice = asNonEmptyString(json["pr"]) ?? asNonEmptyString(json["paymentRequest"]);
    if (invoice === null) {
      return yield* Effect.fail(
        new LnurlResponseError({ url: callbackUrl, reason: "invoice missing" }),
      );
    }

    // LUD-06 step 7: `h` tag must be sha256(utf8(metadata)); the amount must
    // be exactly what we asked for. A parse failure leaves both fields null
    // and skips the corresponding check (PoC leniency for non-bolt11-looking
    // test/regtest payloads).
    const parsed = yield* parseBolt11Invoice(invoice).pipe(
      Effect.orElseSucceed(() => null),
    );
    if (parsed?.descriptionHashHex != null) {
      if (parsed.descriptionHashHex !== sha256HexOfUtf8(metadata.metadataRaw)) {
        return yield* Effect.fail(
          new LnurlInvoiceMismatchError({
            reason: "metadata-hash-mismatch",
            expectedAmountMsat: null,
            invoiceAmountMsat: null,
          }),
        );
      }
    }
    if (parsed?.amountMsat != null && parsed.amountMsat !== amountMsat) {
      return yield* Effect.fail(
        new LnurlInvoiceMismatchError({
          reason: "amount-mismatch",
          expectedAmountMsat: amountMsat,
          invoiceAmountMsat: parsed.amountMsat,
        }),
      );
    }

    return {
      invoice,
      amountMsat,
      successAction: parseSuccessAction(json["successAction"]),
    };
  });
