/**
 * chatPaymentsModel — the PURE half of chat payments (#44;
 * `chat-pay.send-cashu` / `chat-pay.receive-cashu`). No React, no storage.
 *
 * A "token message" is a plain kind-14 chat message whose content carries a
 * serialized Cashu token (the PoC sends the bare token text as the message
 * body; detection scans the content like the PoC's
 * `getCashuTokenMessageInfo`, so tokens pasted inside text are recognized
 * too). The token's amount/mint are decoded locally — bearer material never
 * leaves the message content.
 *
 * Transaction-row contracts (#43 merge, see transactionsModel.ts):
 *
 * - the EMIT row (`cashu` / `emit`) records the swap that created the
 *   outgoing token and carries `detailsJson.issuedTokenId` (the issued
 *   `cashuToken` row id);
 * - the SPEND row (`contacts` / `cashu-chat`) records the chat payment and
 *   carries `detailsJson.usedTokenIds: [issuedTokenId]` — so history merges
 *   emit-then-send into ONE "Sent to contact" item;
 * - the RECEIVE row (`contacts` / `cashu-chat`, direction "in") logs an
 *   auto-accepted incoming token.
 */
import { extractCashuTokenFromText, parseCashuToken } from "@linky/core";
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
