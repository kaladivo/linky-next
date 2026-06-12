/**
 * Pending contact-payment queue — PURE policy half (#46, `chat-pay.queue`).
 * The impure storage/flush half lives in ./pendingPaymentQueue.ts.
 *
 * ## What a queued entry is — the fund-safety story
 *
 * A queue entry is an INTENT: amount + peer, captured when a contact
 * payment could not even be MINTED (the mint was unreachable —
 * `MintConnectionError` from the swap). Nothing has left the wallet at
 * that point, so retrying an intent later mints fresh; the matching PoC
 * mechanism is `LocalPendingPayment` (`linky.local.pendingPayments.v1`:
 * contactId + amountSat + createdAtSec, enqueued by
 * `usePayContactWithCashuMessage` when `navigator.onLine === false`).
 *
 * A MINTED-but-undelivered token is deliberately NOT in this queue: once
 * the swap succeeded the token exists as an `issued` row and its chat
 * message sits in the core NostrPendingQueue, which already retries
 * delivery on relay reconnect (#29) — and the issued row stays returnable
 * through the #38 Return flow with NUT-07 claim detection. Re-queueing the
 * INTENT after a successful mint would double-mint on retry; that is the
 * invariant this split protects.
 *
 * ## Expiry policy
 *
 * `QUEUED_PAYMENT_EXPIRY_SEC` = 24 h. Neither Cashu nor NUT-18 defines an
 * intent lifetime and the PoC queued FOREVER (verified absence — a
 * mandated divergence: the feature-map contract requires expiry). The
 * anchor is the de-facto Lightning practice for payment validity (LND's
 * default BOLT11 invoice expiry is 86 400 s): long enough to survive a day
 * offline, short enough that a forgotten intent cannot fire weeks later.
 * An expired intent was never minted, so "funds returned" is literal:
 * nothing ever left the wallet; the UX marks the history row expired and
 * toasts.
 */

export interface PendingPaymentIntent {
  /** Local queue id (client-tag shaped). */
  readonly id: string;
  /** Saved contact the payment targets (PoC parity: contacts only). */
  readonly contactId: string;
  /** The peer's npub at enqueue time — retries pay THIS identity. */
  readonly peerNpub: string;
  readonly amountSat: number;
  /** Enqueue time; the expiry anchor — retries must NOT refresh it. */
  readonly createdAtSec: number;
  /** The pending spend transaction row mirroring this intent in history. */
  readonly transactionId: string;
}

export const PENDING_PAYMENTS_STORAGE_KEY = "linky.chatPay.pendingPayments.v1";

/** 24 h, the LND-default BOLT11 invoice lifetime (module doc). */
export const QUEUED_PAYMENT_EXPIRY_SEC = 24 * 60 * 60;

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim() !== "";

const isPositiveInt = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0;

const decodeIntent = (value: unknown): PendingPaymentIntent | null => {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (
    !isNonEmptyString(record.id) ||
    !isNonEmptyString(record.contactId) ||
    !isNonEmptyString(record.peerNpub) ||
    !isPositiveInt(record.amountSat) ||
    !isPositiveInt(record.createdAtSec) ||
    !isNonEmptyString(record.transactionId)
  ) {
    return null;
  }
  return {
    id: record.id,
    contactId: record.contactId,
    peerNpub: record.peerNpub,
    amountSat: record.amountSat,
    createdAtSec: record.createdAtSec,
    transactionId: record.transactionId,
  };
};

/**
 * Stored queue (JSON array, enqueue order) → intents. Defensive: a corrupt
 * payload decodes to an empty queue and individually invalid entries are
 * dropped — a broken entry must never wedge the whole flush loop.
 */
export const decodePendingPayments = (
  raw: string | null,
): ReadonlyArray<PendingPaymentIntent> => {
  if (raw === null || raw.trim() === "") return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((entry) => decodeIntent(entry))
      .filter((entry): entry is PendingPaymentIntent => entry !== null);
  } catch {
    return [];
  }
};

export const encodePendingPayments = (
  intents: ReadonlyArray<PendingPaymentIntent>,
): string => JSON.stringify(intents);

export const isPendingPaymentExpired = (
  intent: PendingPaymentIntent,
  nowSec: number,
): boolean => nowSec - intent.createdAtSec >= QUEUED_PAYMENT_EXPIRY_SEC;

export interface PendingPaymentPartition {
  /** Past the expiry window — funds-return path (never minted). */
  readonly expired: ReadonlyArray<PendingPaymentIntent>;
  /** Still alive — retry oldest-first (enqueue order preserved). */
  readonly due: ReadonlyArray<PendingPaymentIntent>;
}

export const partitionPendingPayments = (
  intents: ReadonlyArray<PendingPaymentIntent>,
  nowSec: number,
): PendingPaymentPartition => ({
  expired: intents.filter((intent) => isPendingPaymentExpired(intent, nowSec)),
  due: intents.filter((intent) => !isPendingPaymentExpired(intent, nowSec)),
});
