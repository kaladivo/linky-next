/**
 * Notification copy resolution (#52, `notifications.notify-message` /
 * `notifications.notify-payment`) — pure rich-vs-generic decision, PoC
 * parity (`useInboxNotificationsSync` + `cashuNotificationCopy`):
 *
 * - RICH copy (sender name, content preview, amount) exists only where
 *   on-device decryption happened: the app's own inbox loop decrypted the
 *   rumor (foreground) or the wallet accepted the carried token (amount).
 * - The Cashu TOKEN message itself stays quiet (returns null — bearer
 *   material must not be previewed; PoC `isCashuMessage` guard). The
 *   separate payment notice/accept is what alerts.
 * - GENERIC copy is what the service sends for the closed-app path ("Linky"
 *   / "You have a new message", pinned to apps/push/src/watcher.ts) — the
 *   service cannot decrypt, so anything not provably decryptable on-device
 *   falls back to it.
 */

export interface NotificationCopy {
  readonly title: string;
  readonly body: string;
}

/**
 * The exact generic copy the service sends (apps/push watcher constants).
 * Used by tests and the debug screen; the app itself never has to render
 * it — iOS shows the remote payload's copy directly when the app is closed.
 */
export const GENERIC_NOTIFICATION_COPY: NotificationCopy = {
  title: "Linky",
  body: "You have a new message",
};

/** PoC preview cap (80 chars + ellipsis). */
const PREVIEW_MAX_CHARS = 80;

export const messagePreview = (content: string): string => {
  const trimmed = content.trim();
  return trimmed.length > PREVIEW_MAX_CHARS
    ? `${trimmed.slice(0, PREVIEW_MAX_CHARS)}…`
    : trimmed;
};

export interface MessageCopyInput {
  /** Resolved sender display name (contact name or short-npub fallback). */
  readonly senderName: string;
  /** Decrypted message content. */
  readonly content: string;
  /** True when the content carries a Cashu token (kept quiet). */
  readonly isCashuTokenMessage: boolean;
}

/**
 * Rich copy for a decrypted inbound chat message; `null` = stay quiet
 * (token messages: the wallet's accept path produces the payment copy).
 */
export const resolveMessageCopy = (input: MessageCopyInput): NotificationCopy | null => {
  if (input.isCashuTokenMessage) return null;
  const body = messagePreview(input.content);
  if (body === "") return null;
  return { title: input.senderName, body };
};

export interface PaymentCopyInput {
  readonly senderName: string;
  /** Accepted amount in sat when the wallet already swapped the token. */
  readonly amountSat: number | null;
  /** Localized "You received money" (locales: notificationReceivedMoney). */
  readonly receivedMoneyText: string;
  /** Localized "You received {amount} sat" with the amount substituted. */
  readonly receivedAmountText: ((amountSat: number) => string) | null;
}

/**
 * Rich copy for an incoming chat payment. The amount appears only when the
 * on-device wallet actually decrypted + accepted the token; otherwise the
 * amount-less received-money copy (PoC wording) is used.
 */
export const resolvePaymentCopy = (input: PaymentCopyInput): NotificationCopy => ({
  title: input.senderName,
  body:
    input.amountSat !== null && input.amountSat > 0 && input.receivedAmountText !== null
      ? input.receivedAmountText(input.amountSat)
      : input.receivedMoneyText,
});
