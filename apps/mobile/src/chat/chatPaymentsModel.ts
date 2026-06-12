/**
 * chatPaymentsModel — the PURE half of chat payments (#44 + #45;
 * `chat-pay.send-cashu` / `chat-pay.receive-cashu` / `chat-pay.request` /
 * `chat-pay.pay-request` / `chat-pay.decline-request`). No React, no
 * storage.
 *
 * A "token message" is a plain kind-14 chat message whose content carries a
 * serialized Cashu token (the PoC sends the bare token text as the message
 * body; detection scans the content like the PoC's
 * `getCashuTokenMessageInfo`, so tokens pasted inside text are recognized
 * too). The token's amount/mint are decoded locally — bearer material never
 * leaves the message content.
 *
 * A "request message" (#45) is a kind-14 whose content is a NUT-18 `creqA`
 * payment request; a "decline message" carries the
 * `linky:req-decline:v1:<rumorId>` marker (both core codecs, golden-pinned
 * in packages/core paymentRequests.golden.json). Responses tie back to a
 * request by REPLYING to its rumor — {@link latestRequestResponses}
 * derives each request card's status: the LATEST reply that is a token
 * message ("paid") or a decline marker ("declined") wins, no reply means
 * "requested" (PoC ChatPage `latestRequestResponseByRumorId`; pay can
 * supersede an earlier decline and vice versa).
 *
 * Transaction-row contracts (#43 merge, see transactionsModel.ts):
 *
 * - the EMIT row (`cashu` / `emit`) records the swap that created the
 *   outgoing token and carries `detailsJson.issuedTokenId` (the issued
 *   `cashuToken` row id);
 * - the SPEND row (`contacts` / `cashu-chat`) records the chat payment and
 *   carries `detailsJson.usedTokenIds: [issuedTokenId]` — so history merges
 *   emit-then-send into ONE "Sent to contact" item; paying a request adds
 *   `detailsJson.requestId` (#45, support visibility);
 * - the RECEIVE row (`contacts` / `cashu-chat`, direction "in") logs an
 *   auto-accepted incoming token; a token answering OUR OWN request adds
 *   `detailsJson.requestId` — that is the fulfillment row the #43 merge
 *   folds into the request row ("paid" status, `tx.request-status`);
 * - the REQUEST row (`contacts` / `chat-request`, direction "in", status
 *   "pending") records an outgoing payment request, carrying
 *   `detailsJson.requestId` + `requestText` (#43 `tx.request-status`).
 */
import { extractCashuTokenFromText, parseCashuToken } from "@linky/core";
import {
  parsePaymentRequestContent,
  parsePaymentRequestDeclineContent,
} from "@linky/core";
import type { PaymentRequestInfo } from "@linky/core";
import type { MessageRecord } from "@linky/evolu-store";
import { Effect, Either, Option } from "effect";

// ─── Transaction-row constants (#43 contracts) ───────────────────────────

/** Spend/receive rows render as contact transactions (transactionsModel). */
export const CHAT_PAY_TRANSACTION_CATEGORY = "contacts";
export const CHAT_PAY_TRANSACTION_METHOD = "cashu-chat";

/** The emit half (token swap) — merged away by #43 once the spend lands. */
export const EMIT_TRANSACTION_CATEGORY = "cashu";
export const EMIT_TRANSACTION_METHOD = "emit";

// ─── Token-message detection ─────────────────────────────────────────────

export interface TokenMessageInfo {
  /** The serialized token exactly as found in the message content. */
  readonly tokenText: string;
  readonly amountSat: number;
  readonly mintUrl: string;
  readonly unit: string;
}

/**
 * Decodes the Cashu token carried by a message's content; null when the
 * content holds no readable token (then it renders as plain text).
 */
export const tokenMessageInfo = (content: string): TokenMessageInfo | null => {
  const extracted = Option.getOrNull(extractCashuTokenFromText(content));
  if (extracted === null) return null;
  const parsed = Effect.runSync(Effect.either(parseCashuToken(extracted)));
  if (Either.isLeft(parsed)) return null;
  return {
    tokenText: extracted,
    amountSat: parsed.right.amount,
    mintUrl: parsed.right.mintUrl,
    unit: parsed.right.unit,
  };
};

/** Display host of a token's mint URL ("https://mint.x.y" → "mint.x.y"). */
export const mintHostOf = (mintUrl: string): string =>
  mintUrl.replace(/^https?:\/\//i, "").replace(/\/.*$/, "");

/** Positive integer sat amount from the pay-modal input; null = invalid. */
export const parseChatPayAmount = (text: string): number | null => {
  const normalized = text.trim().replace(/\s+/g, "");
  if (!/^[0-9]+$/.test(normalized)) return null;
  const amount = Number(normalized);
  return Number.isSafeInteger(amount) && amount > 0 ? amount : null;
};

// ─── Payment requests (#45) ──────────────────────────────────────────────

export type { PaymentRequestInfo };

/** The NUT-18 request carried by a message's content; null = not one. */
export const requestMessageInfo = (content: string): PaymentRequestInfo | null =>
  parsePaymentRequestContent(content);

/** The decline marker's embedded request rumor id; null = not a decline. */
export const declineMessageInfo = (
  content: string,
): { readonly requestRumorId: string | null } | null =>
  parsePaymentRequestDeclineContent(content);

/** A request card's derived state (`chat-pay.request` contract). */
export type RequestCardStatus = "requested" | "paid" | "declined";

export interface RequestResponse {
  readonly status: Exclude<RequestCardStatus, "requested">;
  readonly respondedAtSec: number;
}

/**
 * Latest response per request rumor id, derived from the loaded window's
 * replies (PoC ChatPage): a reply that is a token message means "paid", a
 * decline marker means "declined"; the newest `sentAtSec` wins (a tie goes
 * to the later-seen message, PoC iteration order). Requests absent from
 * the map are still "requested".
 */
export const latestRequestResponses = (
  messages: ReadonlyArray<MessageRecord>,
): ReadonlyMap<string, RequestResponse> => {
  const byRumorId = new Map<string, RequestResponse>();
  for (const message of messages) {
    if (message.replyToRumorId === null) continue;
    const isPayment = tokenMessageInfo(message.content) !== null;
    const isDecline = !isPayment && declineMessageInfo(message.content) !== null;
    if (!isPayment && !isDecline) continue;
    const previous = byRumorId.get(message.replyToRumorId);
    if (previous !== undefined && previous.respondedAtSec > message.sentAtSec) continue;
    byRumorId.set(message.replyToRumorId, {
      status: isPayment ? "paid" : "declined",
      respondedAtSec: message.sentAtSec,
    });
  }
  return byRumorId;
};

/**
 * Request ids declined via chat, for the #43 history seam
 * (`tx.request-status`): a decline message's CONTENT names the request
 * rumor id (redundant with the reply tags — the PoC's transactions screen
 * reads the content, mirrored here); the rumor id maps to the request's
 * NUT-18 `requestId`. Paid-over-declined precedence is the history
 * builder's concern (a fulfillment row always wins, PoC parity).
 */
export const declinedRequestIds = (
  requestMessages: ReadonlyArray<{ readonly rumorId: string; readonly content: string }>,
  declineMessages: ReadonlyArray<{ readonly content: string }>,
): ReadonlySet<string> => {
  const requestIdByRumorId = new Map<string, string>();
  for (const message of requestMessages) {
    const info = requestMessageInfo(message.content);
    if (info?.requestId == null) continue;
    requestIdByRumorId.set(message.rumorId, info.requestId);
  }
  const declined = new Set<string>();
  for (const message of declineMessages) {
    const rumorId = declineMessageInfo(message.content)?.requestRumorId;
    if (rumorId == null) continue;
    const requestId = requestIdByRumorId.get(rumorId);
    if (requestId !== undefined) declined.add(requestId);
  }
  return declined;
};

// ─── chat-pay.contact-method (#46) ───────────────────────────────────────

export type ContactPayMethod = "cashu" | "lightning";

/**
 * The pay sheet's method-choice state for one peer (`chat-pay.contact-method`).
 *
 * PoC policy (useContactPayMethod + ContactPayPage):
 * - Cashu is usable when the `settings.pay-with-cashu` toggle is on AND the
 *   peer has a Nostr identity (npub);
 * - Lightning is usable when the contact has a lightning address;
 * - the DEFAULT prefers Cashu when usable, else Lightning;
 * - when BOTH are usable the chooser is shown — the user's explicit pick is
 *   what gets paid, and a failing method NEVER falls back to the other one
 *   (feature-map contract: contact pay never silently switches).
 *
 * Divergence from the PoC: with NO usable method the PoC kept "lightning"
 * as a cosmetic default for its toggle button; here `defaultMethod` is null
 * and the send button disables (same observable outcome — nothing payable).
 */
export interface ContactPayMethodOptions {
  readonly canUseCashu: boolean;
  readonly canUseLightning: boolean;
  /** Pre-selected method when the user has not chosen; null = none usable. */
  readonly defaultMethod: ContactPayMethod | null;
  /** Both usable → render the explicit Cashu/Lightning chooser. */
  readonly showChooser: boolean;
}

export const contactPayMethodOptions = (args: {
  readonly peerNpub: string | null;
  readonly lnAddress: string | null;
  readonly payWithCashuEnabled: boolean;
}): ContactPayMethodOptions => {
  const canUseCashu =
    args.payWithCashuEnabled && args.peerNpub !== null && args.peerNpub.trim() !== "";
  const canUseLightning = (args.lnAddress ?? "").trim() !== "";
  const defaultMethod: ContactPayMethod | null = canUseCashu
    ? "cashu"
    : canUseLightning
      ? "lightning"
      : null;
  return { canUseCashu, canUseLightning, defaultMethod, showChooser: canUseCashu && canUseLightning };
};
