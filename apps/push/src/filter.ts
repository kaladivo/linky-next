/**
 * Wrap classification (notifications.service-filter) — decides whether an
 * observed relay event may notify, WITHOUT decrypting anything.
 *
 * The only alert signal available to the service is the wrap-level
 * `["linky", "push"]` marker that `@linky/core`'s `createChatGiftWraps`
 * puts on the RECIPIENT wrap of alert-worthy sends:
 *
 * - chat messages → marker on the recipient wrap → alert;
 * - payment notice events (chat-pay.notice, #44) → marker → alert;
 * - the sender's self/sync copy → no marker → quiet;
 * - reactions, edits, deletions → sent without marker → quiet;
 * - Cashu token messages themselves → sent without marker → quiet (the
 *   separate payment notice carries the alert, per chat-payments.md).
 *
 * Everything else is shape validation: only structurally valid, correctly
 * signed kind-1059 wraps addressed to exactly one recipient pass. The
 * service never sees message content — the wrap payload stays opaque.
 */
import type { NostrEvent } from "@linky/core";
import { GIFT_WRAP_KIND, LINKY_PUSH_MARKER_TAG, verifyNostrEvent } from "@linky/core";

const HEX64 = /^[0-9a-f]{64}$/;

export type WrapClassification =
  | { readonly _tag: "deliver"; readonly recipientPubkey: string }
  | { readonly _tag: "ignore"; readonly reason: WrapIgnoreReason };

export type WrapIgnoreReason =
  | "wrong-kind"
  | "empty-content"
  | "recipient-count"
  | "no-push-marker"
  | "invalid-signature";

const ignore = (reason: WrapIgnoreReason): WrapClassification => ({ _tag: "ignore", reason });

/**
 * Cheap checks first, the Schnorr verification last — the marker check
 * discards the bulk of inbox traffic (sync copies, reactions) before any
 * crypto runs.
 */
export const classifyWrap = (event: NostrEvent): WrapClassification => {
  if (event.kind !== GIFT_WRAP_KIND) return ignore("wrong-kind");
  if (event.content.trim() === "") return ignore("empty-content");

  let recipientPubkey: string | null = null;
  for (const tag of event.tags) {
    if (tag[0] !== "p") continue;
    const candidate = tag[1];
    if (candidate === undefined || !HEX64.test(candidate)) return ignore("recipient-count");
    if (recipientPubkey !== null && recipientPubkey !== candidate) {
      return ignore("recipient-count");
    }
    recipientPubkey = candidate;
  }
  if (recipientPubkey === null) return ignore("recipient-count");

  const [markerTag, markerValue] = LINKY_PUSH_MARKER_TAG;
  const marked = event.tags.some((tag) => tag[0] === markerTag && tag[1] === markerValue);
  if (!marked) return ignore("no-push-marker");

  if (!verifyNostrEvent(event)) return ignore("invalid-signature");

  return { _tag: "deliver", recipientPubkey };
};
