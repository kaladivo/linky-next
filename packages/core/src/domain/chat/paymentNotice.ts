/**
 * Payment notice (`chat-pay.notice`, issue #44) — the notify-only event a
 * Cashu chat payment sends ALONGSIDE the token message, pinned to the PoC's
 * wire format (`pushWrappedEvent.ts` `createLinkyPaymentNoticeEvent`,
 * golden fixtures in `__fixtures__/chatPayments.golden.json`):
 *
 * - **rumor** — kind 24133, content `"payment_notice"`, tags
 *   `p` recipient, `p` sender, `client` local id, and the notice marker
 *   `["linky", "payment_notice"]`.
 * - **wrap** — a SINGLE recipient-directed gift wrap carrying the
 *   `["linky", "push"]` push marker (the PoC's `wrapEventWithPushMarker`);
 *   there is NO self/sync wrap — the notice exists only to ring the
 *   recipient's phone via the push relay (apps/push honors the marker).
 *
 * Division of labour with the token message (chat-payments.md contract,
 * "Token chat messages and notification-trigger notice events are separate
 * things"): the token message carries the value and is sent QUIET (no push
 * marker on either wrap); the notice carries the alert and no value. The
 * inbox engine deliberately does NOT model kind 24133 as a ChatEvent —
 * `classifyRumor` rejects it as `unsupported-kind`, so a received notice is
 * never stored or rendered (PoC parity: only the service worker reads it).
 */
import type { NostrEventTemplate } from "../nostr/NostrEvent.js";

/** The PoC's ephemeral-style notice kind (not a stored chat rumor kind). */
export const PAYMENT_NOTICE_KIND = 24133;

/** Content AND marker-tag value of a payment notice (PoC constant). */
export const PAYMENT_NOTICE_VALUE = "payment_notice";

/** The rumor-level notice marker tag (distinct from the wrap push marker). */
export const PAYMENT_NOTICE_MARKER_TAG: readonly [string, string] = [
  "linky",
  PAYMENT_NOTICE_VALUE,
];

export interface PaymentNoticeTemplateInput {
  readonly senderPublicKeyHex: string;
  readonly recipientPublicKeyHex: string;
  readonly createdAtSec: number;
  /** Local id (the PoC sets one on notices too). */
  readonly clientTag: string;
}

/** A kind-24133 payment notice template (PoC tag layout, byte-exact). */
export const makePaymentNoticeTemplate = (
  input: PaymentNoticeTemplateInput,
): NostrEventTemplate => ({
  kind: PAYMENT_NOTICE_KIND,
  created_at: input.createdAtSec,
  tags: [
    ["p", input.recipientPublicKeyHex],
    ["p", input.senderPublicKeyHex],
    ["client", input.clientTag],
    [...PAYMENT_NOTICE_MARKER_TAG],
  ],
  content: PAYMENT_NOTICE_VALUE,
});

/** The PoC's `isLinkyPaymentNoticeEvent`: kind 24133 + the notice marker. */
export const isPaymentNoticeRumor = (rumor: {
  readonly kind: number;
  readonly tags: ReadonlyArray<ReadonlyArray<string>>;
}): boolean =>
  rumor.kind === PAYMENT_NOTICE_KIND &&
  rumor.tags.some(
    (tag) => tag[0] === PAYMENT_NOTICE_MARKER_TAG[0] && tag[1] === PAYMENT_NOTICE_MARKER_TAG[1],
  );
