/**
 * In-app rich notifications (#52, `notifications.notify-message` /
 * `notifications.notify-payment`) — the on-device half of the copy split.
 *
 * WHERE RICH COPY CAN EXIST: only where decryption happened. Without an iOS
 * Notification Service Extension (not expressible through Expo config
 * plugins — CNG rule), the OS banner for a closed app shows the service's
 * GENERIC copy. When the app is awake to render, ITS decrypted inbox is the
 * copy source: the chat inbox runner calls in here for newly applied
 * inbound messages / accepted chat payments, and a rich LOCAL notification
 * (sender name, content preview, amount) is presented — PoC parity with
 * `useInboxNotificationsSync`'s `maybeShowPwaNotification`.
 *
 * Duplicate-alert rules (notifications.closed-app):
 * - presented only while the app is ACTIVE — exactly the state in which the
 *   foreground handler suppresses the duplicate remote (generic) banner;
 * - never for the conversation currently on screen (live bubbles are the
 *   surface);
 * - never for Cashu token message content (bearer material stays quiet —
 *   the wallet's accept produces the payment copy with the amount instead).
 */
import { deriveDefaultProfile } from "@linky/core";
import type { NameLanguage } from "@linky/core";
import type { Translator } from "@linky/locales";
import {
  createContactsRepository,
  createUnknownThreadsRepository,
} from "@linky/evolu-store";
import type { LinkyStore } from "@linky/evolu-store";
import { AppState } from "react-native";

import { getActiveChatThread } from "./activeThread";
import { presentLocalNotification } from "./expoNotificationsModule";
import { recordNotificationDelivery } from "./notificationActions";
import { resolveMessageCopy, resolvePaymentCopy } from "./notificationCopy";
import type { NotificationCopy } from "./notificationCopy";

interface NotifierContext {
  readonly t: Translator;
  readonly lang: NameLanguage;
}

let context: NotifierContext | null = null;

/** Idempotent; called from deferred startup with the resolved locale. */
export const initInAppRichNotifier = (t: Translator, lang: NameLanguage): void => {
  context = { t, lang };
};

interface ResolvedPeer {
  readonly chatId: string;
  readonly displayName: string;
}

/** chat route id + display name for a peer npub (contact or unknown). */
const resolvePeer = async (
  store: LinkyStore,
  peerNpub: string,
  ctx: NotifierContext,
): Promise<ResolvedPeer | null> => {
  const contact = await createContactsRepository(store).findByNpub(peerNpub);
  if (contact !== null) {
    const name =
      contact.name !== null && contact.name.trim().length > 0
        ? contact.name
        : deriveDefaultProfile(peerNpub, ctx.lang).name;
    return { chatId: contact.id, displayName: name };
  }
  const thread = await createUnknownThreadsRepository(store).getByNpub(peerNpub);
  if (thread !== null) {
    return {
      chatId: thread.id,
      displayName: deriveDefaultProfile(peerNpub, ctx.lang).name,
    };
  }
  return null;
};

const present = (peer: ResolvedPeer, copy: NotificationCopy): void => {
  void presentLocalNotification({
    title: copy.title,
    body: copy.body,
    chatId: peer.chatId,
  })
    .then(() => {
      recordNotificationDelivery({
        receivedAtMs: Date.now(),
        eventId: null,
        presentation: "local-rich",
      });
    })
    .catch(() => undefined);
};

const shouldAlert = (chatId: string): boolean =>
  AppState.currentState === "active" && getActiveChatThread() !== chatId;

/** Rich alert for a newly applied inbound text message (non-token). */
export const notifyInboundChatMessage = async (
  store: LinkyStore,
  args: { readonly peerNpub: string; readonly content: string },
): Promise<void> => {
  const ctx = context;
  if (ctx === null) return;
  try {
    const peer = await resolvePeer(store, args.peerNpub, ctx);
    if (peer === null || !shouldAlert(peer.chatId)) return;
    const copy = resolveMessageCopy({
      senderName: peer.displayName,
      content: args.content,
      isCashuTokenMessage: false, // runner routes token messages to the payment path
    });
    if (copy !== null) present(peer, copy);
  } catch {
    // Alerting is best-effort; never disturb the inbox loop.
  }
};

/** Rich payment alert after the wallet accepted an incoming chat token. */
export const notifyIncomingChatPayment = async (
  store: LinkyStore,
  args: { readonly peerNpub: string; readonly amountSat: number | null },
): Promise<void> => {
  const ctx = context;
  if (ctx === null) return;
  try {
    const peer = await resolvePeer(store, args.peerNpub, ctx);
    if (peer === null || !shouldAlert(peer.chatId)) return;
    present(
      peer,
      resolvePaymentCopy({
        senderName: peer.displayName,
        amountSat: args.amountSat,
        receivedMoneyText: ctx.t("notificationReceivedMoney"),
        receivedAmountText: (amountSat) =>
          ctx.t("notificationReceivedAmount", { amount: amountSat }),
      }),
    );
  } catch {
    // Best-effort.
  }
};
