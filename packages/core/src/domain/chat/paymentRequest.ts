/**
 * Chat payment requests (issue #45; `chat-pay.request` /
 * `chat-pay.pay-request` / `chat-pay.decline-request`) — the NUT-18 wire
 * codec plus the Linky decline marker, pinned to the PoC's
 * `paymentRequestMessage.ts` (golden fixtures in
 * `__fixtures__/paymentRequests.golden.json`).
 *
 * ## Wire shapes (PoC = source of truth)
 *
 * - **Request**: a plain kind-14 chat message whose content is a NUT-18
 *   encoded payment request — `"creqA"` + base64(CBOR map) with fields
 *   `a` amount (sats), `u` `"sat"`, `s` true (single use), `m` mint URLs,
 *   `i` a client-generated request id, and one nostr transport
 *   `t: [{t: "nostr", a: <REQUESTER's nprofile>, g: [["n","17"]]}]` — the
 *   nprofile (pubkey + relay hints) tells the payer where the NIP-17 token
 *   message should go. Encoding goes through `@cashu/cashu-ts`'s
 *   `PaymentRequest` (the PoC encodes with cbor-x; both emit standard CBOR
 *   maps and each parses the other's output — both directions are pinned
 *   in the golden fixtures).
 * - **Pay response**: a normal Cashu token chat message REPLYING to the
 *   request rumor (`e` root/reply tags = the request's rumor id). No
 *   special content marker — the tie-back is the reply reference.
 * - **Decline response**: a chat message replying to the request rumor
 *   whose content is `linky:req-decline:v1:<requestRumorId>` (the rumor id
 *   is ALSO embedded in the content, PoC shape — history mirroring reads
 *   it from there without needing the reply tags).
 * - **Status**: derived, never stored on the wire — for one request rumor,
 *   the LATEST reply (by `created_at`) that is a token message ("paid") or
 *   a decline marker ("declined") wins; no reply means "requested".
 */
import { PaymentRequest } from "@cashu/cashu-ts";

import { decodeNprofile } from "../nostr/nprofile.js";

/** NUT-18 serialization prefix (version A). */
export const PAYMENT_REQUEST_PREFIX = "creqA";

/** The Linky decline marker prefix (PoC constant, versioned). */
export const PAYMENT_REQUEST_DECLINE_PREFIX = "linky:req-decline:v1";

/** The NUT-18 nostr transport tag set: NIP-17 direct messages. */
const NOSTR_TRANSPORT_TAGS: Array<Array<string>> = [["n", "17"]];

// ---------------------------------------------------------------------------
// Request encoding
// ---------------------------------------------------------------------------

export interface BuildPaymentRequestInput {
  /** Positive integer amount in sats. */
  readonly amountSat: number;
  /** Acceptable mints (the PoC sends exactly one: the preferred mint). */
  readonly mintUrls: ReadonlyArray<string>;
  /** The REQUESTER's nprofile (pubkey + relays): where payment goes. */
  readonly requesterNprofile: string;
  /** Client-generated id tying responses & history to this request. */
  readonly requestId: string;
  readonly description?: string;
}

/**
 * Encodes a NUT-18 payment request the way the PoC sends one (`a`/`u`/`s`/
 * `m`/`t`/`i` fields, unit `"sat"`, single use, one NIP-17 nostr
 * transport). Returns `null` for a non-positive amount (defensive).
 */
export const buildPaymentRequestContent = (input: BuildPaymentRequestInput): string | null => {
  const amountSat = Math.trunc(input.amountSat);
  if (!Number.isFinite(input.amountSat) || amountSat <= 0) return null;
  const mintUrls = input.mintUrls.map((url) => url.trim()).filter((url) => url !== "");
  const description = input.description?.trim();
  return new PaymentRequest(
    [
      {
        type: "nostr",
        target: input.requesterNprofile,
        tags: NOSTR_TRANSPORT_TAGS,
      },
    ],
    input.requestId,
    amountSat,
    "sat",
    mintUrls,
    description === undefined || description === "" ? undefined : description,
    true,
  ).toEncodedRequest();
};

// ---------------------------------------------------------------------------
// Request parsing (PoC `parseCashuPaymentRequestMessage` semantics)
// ---------------------------------------------------------------------------

export interface PaymentRequestInfo {
  /** Positive integer sats (truncated like the PoC). */
  readonly amountSat: number;
  /** Always `"sat"` — anything else is rejected (PoC rule). */
  readonly unit: string;
  readonly mintUrls: ReadonlyArray<string>;
  /** The `i` field; `null` when absent (still a renderable request). */
  readonly requestId: string | null;
  readonly description: string | null;
  /** The nostr transport target IF it decodes as an nprofile, else null. */
  readonly transportNprofile: string | null;
  /** The trimmed encoded request exactly as carried by the message. */
  readonly encoded: string;
}

/**
 * Decodes a chat message's content as a NUT-18 payment request; `null`
 * when it isn't one (then the message renders as plain text). Acceptance
 * matches the PoC: `creqA` prefix, a positive finite amount, unit `"sat"`
 * (case-insensitive); everything else is optional.
 */
export const parsePaymentRequestContent = (content: string): PaymentRequestInfo | null => {
  const encoded = content.trim();
  if (!encoded.startsWith(PAYMENT_REQUEST_PREFIX)) return null;

  let request: PaymentRequest;
  try {
    request = PaymentRequest.fromEncodedRequest(encoded);
  } catch {
    return null;
  }

  if (typeof request.amount !== "number" || !Number.isFinite(request.amount)) return null;
  const amountSat = Math.trunc(request.amount);
  if (amountSat <= 0) return null;

  const unit = typeof request.unit === "string" ? request.unit.trim().toLowerCase() : "";
  if (unit !== "sat") return null;

  const mintUrls = (Array.isArray(request.mints) ? request.mints : [])
    .filter((url): url is string => typeof url === "string")
    .map((url) => url.trim())
    .filter((url) => url !== "");

  const requestId = typeof request.id === "string" ? request.id.trim() : "";
  const description = typeof request.description === "string" ? request.description.trim() : "";

  const transportTarget = (Array.isArray(request.transport) ? request.transport : []).find(
    (transport) => String(transport?.type ?? "").trim() === "nostr",
  )?.target;
  const trimmedTarget = typeof transportTarget === "string" ? transportTarget.trim() : "";
  const transportNprofile =
    trimmedTarget !== "" && decodeNprofile(trimmedTarget) !== null ? trimmedTarget : null;

  return {
    amountSat,
    unit,
    mintUrls,
    requestId: requestId === "" ? null : requestId,
    description: description === "" ? null : description,
    transportNprofile,
    encoded,
  };
};

// ---------------------------------------------------------------------------
// Decline marker (PoC `buildLinkyPaymentRequestDeclineMessage`)
// ---------------------------------------------------------------------------

/** `linky:req-decline:v1:<requestRumorId>` — the decline reply's content. */
export const buildPaymentRequestDeclineContent = (requestRumorId: string): string =>
  `${PAYMENT_REQUEST_DECLINE_PREFIX}:${requestRumorId.trim()}`;

export interface PaymentRequestDeclineInfo {
  /** The declined request's rumor id; null when the marker is bare. */
  readonly requestRumorId: string | null;
}

/**
 * Detects a decline message; `null` when the content isn't one. A decline
 * with an empty/unknown rumor id still RENDERS as a decline (PoC parity) —
 * it just can't flip any request's status.
 */
export const parsePaymentRequestDeclineContent = (
  content: string,
): PaymentRequestDeclineInfo | null => {
  const trimmed = content.trim();
  if (!trimmed.startsWith(`${PAYMENT_REQUEST_DECLINE_PREFIX}:`)) return null;
  const requestRumorId = trimmed.slice(PAYMENT_REQUEST_DECLINE_PREFIX.length + 1).trim();
  return { requestRumorId: requestRumorId === "" ? null : requestRumorId };
};
