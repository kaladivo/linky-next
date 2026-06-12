/**
 * Chat conversation screen (#29) — the full messenger experience on top of
 * the #28 thread view: send (optimistic pending → acked), receive (inbox
 * sync via chatInboxRunner), reply with context, edit own messages, emoji
 * reactions (latest per person), and delete chat.
 *
 * Renders one conversation for a saved contact OR an unknown sender — the
 * contacts list routes both here (the id is a contact id or an
 * unknown-thread id, resolved by useChatThread). Unknown senders CAN be
 * replied to (verified PoC behavior): the composer is enabled on unknown
 * threads, under the PoC's warning banner with Add contact / Block.
 *
 * Interaction model (PoC ChatMessage parity, adapted to native):
 * - long-press a bubble → bottom action sheet: emoji row (react), Reply,
 *   Edit (own messages only), Copy;
 * - tap a reaction chip → toggle my reaction with that emoji
 *   (PoC semantics: same emoji = off, different = replace);
 * - reply/edit context bar above the composer with a cancel button;
 * - header 🗑 → Remove chat (local-only delete; see chatActions).
 *
 * The list is inverted (newest at the bottom); reaching the top loads
 * older pages — full history, no hard caps (`chat.retention`).
 */
import { Button, Surface, Text } from "@linky/ui";
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { formatAmountParts } from "@linky/ui/amount";

import {
  deleteChat,
  editChatMessage,
  sendChatMessage,
  toggleReaction,
} from "../../src/chat/chatActions";
import {
  declinePaymentRequestInChat,
  sendCashuInChat,
  sendPaymentRequestInChat,
} from "../../src/chat/chatPayActions";
import { setActiveChatThread } from "../../src/notifications/activeThread";
import {
  contactPayMethodOptions,
  declineMessageInfo,
  latestRequestResponses,
  mintHostOf,
  parseChatPayAmount,
  requestMessageInfo,
  tokenMessageInfo,
} from "../../src/chat/chatPaymentsModel";
import type {
  ContactPayMethod,
  PaymentRequestInfo,
  RequestCardStatus,
  TokenMessageInfo,
} from "../../src/chat/chatPaymentsModel";
import { sendCashuToContactOrQueue } from "../../src/chat/pendingPaymentQueue";
import {
  myReactionsOnMessage,
  reactionChipsByMessage,
  replyPreviewText,
} from "../../src/chat/conversationModel";
import { paidOverlay } from "../../src/paidOverlay";
import { useEffectQuery } from "../../src/runtime";
import { useAmountDisplay } from "../../src/wallet/AmountDisplayProvider";
import { payFailureMessage } from "../../src/wallet/payModel";
import { loadPayWithCashuEnabled } from "../../src/wallet/payWithCashuSetting";
import { paidOverlayTitle } from "../../src/wallet/payOverlayCopy";
import { maybeCheckIssuedTokens } from "../../src/wallet/tokenActions";
import type { ReactionChip } from "../../src/chat/conversationModel";
import { chatThreadNpub, useChatThread } from "../../src/chat/useChatThread";
import type { ChatConversation } from "../../src/chat/useChatThread";
import {
  blockSender,
  promoteUnknownThread,
  warmUnknownSenderMetadata,
} from "../../src/contacts/contactThreadActions";
import {
  contactDisplayName,
  formatPreviewTimestamp,
  unknownThreadDisplayName,
} from "../../src/contacts/contactsListModel";
import { useLocale } from "../../src/locales";
import { copyToClipboard } from "../../src/settings/nostrKeyActions";
import { useLinkyStore } from "../../src/store/useLinkyStore";
import { toast } from "../../src/toast";
import type { MessageRecord } from "@linky/evolu-store";

/** The PoC EmojiPicker's quick row. */
const QUICK_EMOJIS = ["❤️", "👍", "👎", "😂", "😮", "😢"] as const;

const PLACEHOLDER_COLOR = "rgba(226, 232, 240, 0.4)";

// ─── Message bubble ──────────────────────────────────────────────────────

/** Render model of a token-message bubble (chat-pay, #44). */
interface PaymentBubble {
  /** "Sent 21 sat" / "Received 21 sat" (amount-display formatted). */
  readonly label: string;
  /** Mint host, as a small provenance hint. */
  readonly mintHost: string;
}

/** Render model of a payment-request card (chat-pay.request, #45). */
interface RequestBubble {
  /** "Payment request" (localized). */
  readonly title: string;
  /** Amount-display formatted, e.g. "100 sat". */
  readonly amountLabel: string;
  readonly status: RequestCardStatus;
  /** Requested / Paid / Declined (localized). */
  readonly statusLabel: string;
  readonly description: string | null;
  /** Pay/Decline shown only for incoming cards still "requested". */
  readonly canAct: boolean;
  readonly busy: boolean;
  readonly payLabel: string;
  readonly declineLabel: string;
  readonly onPay: () => void;
  readonly onDecline: () => void;
}

interface BubbleProps {
  readonly message: MessageRecord;
  readonly chips: ReadonlyArray<ReactionChip>;
  readonly replyQuote: string | null;
  readonly payment: PaymentBubble | null;
  readonly request: RequestBubble | null;
  /** Localized decline notice when this message is a decline marker. */
  readonly declineText: string | null;
  readonly locale: string;
  readonly pendingLabel: string;
  readonly editedLabel: string;
  readonly onLongPress: (message: MessageRecord) => void;
  readonly onToggleChip: (message: MessageRecord, emoji: string) => void;
}

const STATUS_PILL_CLASS: Record<RequestCardStatus, string> = {
  requested: "bg-black/20",
  paid: "bg-primary/30",
  declined: "bg-black/30",
};

function MessageBubble({
  message,
  chips,
  replyQuote,
  payment,
  request,
  declineText,
  locale,
  pendingLabel,
  editedLabel,
  onLongPress,
  onToggleChip,
}: BubbleProps) {
  const isOut = message.direction === "out";
  const isPending = isOut && message.status === "pending";

  return (
    <View className={`max-w-[82%] ${isOut ? "self-end items-end" : "self-start items-start"}`}>
      <Pressable
        onLongPress={() => onLongPress(message)}
        delayLongPress={350}
        accessibilityLabel={message.content}
        testID={`chat-bubble-${message.rumorId.slice(0, 12)}`}
      >
        <View
          className={`rounded-2xl px-4 py-2.5 ${isOut ? "bg-primary" : "bg-surface"} ${
            isPending ? "opacity-60" : ""
          }`}
        >
          {replyQuote !== null && (
            <View
              className={`mb-1.5 rounded-lg border-l-2 px-2 py-1 ${
                isOut ? "border-background/60 bg-black/10" : "border-primary bg-black/20"
              }`}
            >
              <Text
                numberOfLines={2}
                className={`text-xs ${isOut ? "text-primary-foreground opacity-80" : "opacity-70"}`}
              >
                {replyQuote}
              </Text>
            </View>
          )}
          {payment !== null ? (
            <View
              className="flex-row items-center gap-2 py-0.5"
              testID={`chat-payment-${message.rumorId.slice(0, 12)}`}
            >
              <Text className="text-2xl leading-8">💸</Text>
              <View>
                <Text
                  weight="semibold"
                  className={isOut ? "text-primary-foreground" : "text-foreground"}
                >
                  {payment.label}
                </Text>
                <Text
                  className={`text-xs ${isOut ? "text-primary-foreground opacity-70" : "opacity-50"}`}
                >
                  {payment.mintHost}
                </Text>
              </View>
            </View>
          ) : request !== null ? (
            <View
              className="min-w-[180px] gap-2 py-0.5"
              testID={`chat-request-${message.rumorId.slice(0, 12)}`}
            >
              <View className="flex-row items-center justify-between gap-3">
                <Text
                  className={`text-xs ${isOut ? "text-primary-foreground opacity-80" : "opacity-60"}`}
                >
                  {request.title}
                </Text>
                <View
                  className={`rounded-full px-2 py-0.5 ${STATUS_PILL_CLASS[request.status]}`}
                  testID={`chat-request-status-${message.rumorId.slice(0, 12)}-${request.status}`}
                >
                  <Text
                    weight="semibold"
                    className={`text-xs ${isOut ? "text-primary-foreground" : "text-foreground"}`}
                  >
                    {request.statusLabel}
                  </Text>
                </View>
              </View>
              <Text
                weight="bold"
                className={`text-xl ${isOut ? "text-primary-foreground" : "text-foreground"}`}
              >
                {request.amountLabel}
              </Text>
              {request.description !== null && (
                <Text
                  className={`text-xs ${isOut ? "text-primary-foreground opacity-80" : "opacity-70"}`}
                >
                  {request.description}
                </Text>
              )}
              {request.canAct && (
                <View className="flex-row gap-2 pt-1">
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={request.payLabel}
                    testID={`chat-request-pay-${message.rumorId.slice(0, 12)}`}
                    disabled={request.busy}
                    onPress={request.onPay}
                    className={`flex-1 items-center rounded-xl bg-primary px-3 py-2 ${
                      request.busy ? "opacity-50" : "active:opacity-70"
                    }`}
                  >
                    <Text weight="semibold" className="text-primary-foreground">
                      {request.busy ? "…" : request.payLabel}
                    </Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={request.declineLabel}
                    testID={`chat-request-decline-${message.rumorId.slice(0, 12)}`}
                    disabled={request.busy}
                    onPress={request.onDecline}
                    className={`flex-1 items-center rounded-xl bg-background px-3 py-2 ${
                      request.busy ? "opacity-50" : "active:opacity-70"
                    }`}
                  >
                    <Text weight="semibold">{request.declineLabel}</Text>
                  </Pressable>
                </View>
              )}
            </View>
          ) : declineText !== null ? (
            <Text
              className={`italic ${isOut ? "text-primary-foreground opacity-90" : "opacity-80"}`}
              testID={`chat-decline-${message.rumorId.slice(0, 12)}`}
            >
              {declineText}
            </Text>
          ) : (
            <Text className={isOut ? "text-primary-foreground" : "text-foreground"}>
              {message.content}
            </Text>
          )}
        </View>
      </Pressable>
      {chips.length > 0 && (
        <View className={`flex-row gap-1 px-1 pt-0.5 ${isOut ? "justify-end" : "justify-start"}`}>
          {chips.map((chip) => (
            <Pressable
              key={chip.emoji}
              onPress={() => onToggleChip(message, chip.emoji)}
              accessibilityRole="button"
              accessibilityLabel={`${chip.emoji} ${chip.count}`}
              testID={`chat-chip-${message.rumorId.slice(0, 12)}-${chip.emoji}`}
              className={`flex-row items-center rounded-full px-2 py-0.5 ${
                chip.reactedByMe ? "border border-primary bg-surface" : "bg-surface"
              }`}
            >
              <Text className="text-xs">
                {chip.emoji}
                {chip.count > 1 ? ` ${chip.count}` : ""}
              </Text>
            </Pressable>
          ))}
        </View>
      )}
      <Text className={`px-1 pt-0.5 text-xs opacity-50 ${isOut ? "text-right" : "text-left"}`}>
        {formatPreviewTimestamp(message.sentAtSec, Date.now(), locale)}
        {message.editedAtSec !== null ? ` · ${editedLabel}` : ""}
        {isPending ? ` · ${pendingLabel}` : ""}
      </Text>
    </View>
  );
}

// ─── Message action sheet ────────────────────────────────────────────────

interface ActionSheetProps {
  readonly message: MessageRecord | null;
  readonly canEdit: boolean;
  readonly labels: { readonly reply: string; readonly edit: string; readonly copy: string };
  readonly onClose: () => void;
  readonly onReact: (message: MessageRecord, emoji: string) => void;
  readonly onReply: (message: MessageRecord) => void;
  readonly onEdit: (message: MessageRecord) => void;
  readonly onCopy: (message: MessageRecord) => void;
}

function MessageActionSheet({
  message,
  canEdit,
  labels,
  onClose,
  onReact,
  onReply,
  onEdit,
  onCopy,
}: ActionSheetProps) {
  const insets = useSafeAreaInsets();
  if (message === null) return null;

  const item = (label: string, testID: string, onPress: () => void) => (
    <Pressable
      accessibilityRole="button"
      testID={testID}
      onPress={() => {
        onPress();
        onClose();
      }}
      className="rounded-xl px-4 py-3 active:opacity-60"
    >
      <Text weight="semibold">{label}</Text>
    </Pressable>
  );

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View className="flex-1 justify-end">
        <Pressable
          className="absolute inset-0 bg-black/50"
          onPress={onClose}
          accessibilityLabel="close"
          testID="chat-actions-backdrop"
        />
        <View
          className="rounded-t-3xl bg-surface px-4 pt-4"
          style={{ paddingBottom: insets.bottom + 12 }}
          testID="chat-message-actions"
        >
          <View className="mb-3 flex-row justify-between px-2">
            {QUICK_EMOJIS.map((emoji) => (
              <Pressable
                key={emoji}
                accessibilityRole="button"
                accessibilityLabel={emoji}
                testID={`chat-react-${emoji}`}
                onPress={() => {
                  onReact(message, emoji);
                  onClose();
                }}
                className="h-11 w-11 items-center justify-center rounded-full active:opacity-60"
              >
                <Text className="text-2xl leading-8">{emoji}</Text>
              </Pressable>
            ))}
          </View>
          <View className="h-px bg-background opacity-60" />
          {item(labels.reply, "chat-action-reply", () => onReply(message))}
          {canEdit && item(labels.edit, "chat-action-edit", () => onEdit(message))}
          {item(labels.copy, "chat-action-copy", () => onCopy(message))}
        </View>
      </View>
    </Modal>
  );
}

// ─── Screen ──────────────────────────────────────────────────────────────

export default function ChatScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { t, locale } = useLocale();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const storeState = useLinkyStore();
  const store = storeState.status === "ready" ? storeState.store : null;
  const { state, loadOlder } = useChatThread(store, id ?? null);
  const { unit: amountUnit, hidden: amountHidden } = useAmountDisplay();
  const [busy, setBusy] = useState(false);

  const [draft, setDraft] = useState("");
  const [replyTo, setReplyTo] = useState<MessageRecord | null>(null);
  const [editing, setEditing] = useState<MessageRecord | null>(null);
  const [actionTarget, setActionTarget] = useState<MessageRecord | null>(null);
  const [sendBusy, setSendBusy] = useState(false);

  const [payOpen, setPayOpen] = useState(false);
  const [payAmount, setPayAmount] = useState("");
  const [payBusy, setPayBusy] = useState(false);
  // Explicit method pick (`chat-pay.contact-method`); null = the default.
  const [payMethod, setPayMethod] = useState<ContactPayMethod | null>(null);

  // Claim detection (#44): notice issued chat tokens the peer accepted.
  useEffect(() => {
    if (store !== null) maybeCheckIssuedTokens(store);
  }, [store]);

  // notifications (#52): the open conversation never alerts — the in-app
  // rich notifier skips the active thread (duplicate-alert suppression).
  // Focus-scoped, not mount-scoped: a screen pushed OVER this chat keeps it
  // mounted, but the user is no longer looking at it.
  useFocusEffect(
    useCallback(() => {
      setActiveChatThread(id ?? null);
      return () => setActiveChatThread(null);
    }, [id]),
  );

  const ready: ChatConversation | null = state.status === "ready" ? state : null;
  const unknownThread = ready?.thread.kind === "unknown" ? ready.thread.thread : null;
  const contact = ready?.thread.kind === "contact" ? ready.thread.contact : null;
  const peerNpub = ready === null ? null : chatThreadNpub(ready.thread);

  // Pre-warm the sender's kind-0 metadata so promote can prefill the name.
  useEffect(() => {
    if (unknownThread !== null) warmUnknownSenderMetadata(unknownThread.npub);
  }, [unknownThread?.npub]);

  const title = useMemo(() => {
    if (contact !== null) return contactDisplayName(contact, locale);
    if (unknownThread !== null) {
      return unknownThreadDisplayName(unknownThread.npub, t("unknownContactNamePrefix"), locale);
    }
    return t("chat");
  }, [contact, unknownThread, t, locale]);

  const byRumorId = useMemo(() => {
    const map = new Map<string, MessageRecord>();
    for (const message of ready?.messages ?? []) map.set(message.rumorId, message);
    return map;
  }, [ready?.messages]);

  const chipsByMessage = useMemo(
    () => reactionChipsByMessage(ready?.reactions ?? [], ready?.ownNpub ?? null),
    [ready?.reactions, ready?.ownNpub],
  );

  // Token messages (#44): decoded once per loaded window, rendered as
  // payment bubbles instead of raw token text.
  const paymentInfoByRumorId = useMemo(() => {
    const map = new Map<string, TokenMessageInfo>();
    for (const message of ready?.messages ?? []) {
      const info = tokenMessageInfo(message.content);
      if (info !== null) map.set(message.rumorId, info);
    }
    return map;
  }, [ready?.messages]);

  // Payment requests (#45): NUT-18 cards + the latest response per request
  // (a token reply = paid, a decline marker = declined; latest wins).
  const requestInfoByRumorId = useMemo(() => {
    const map = new Map<string, PaymentRequestInfo>();
    for (const message of ready?.messages ?? []) {
      if (paymentInfoByRumorId.has(message.rumorId)) continue;
      const info = requestMessageInfo(message.content);
      if (info !== null) map.set(message.rumorId, info);
    }
    return map;
  }, [ready?.messages, paymentInfoByRumorId]);

  const requestResponses = useMemo(
    () => latestRequestResponses(ready?.messages ?? []),
    [ready?.messages],
  );

  const [requestActBusy, setRequestActBusy] = useState<string | null>(null);

  const formatSat = (amountSat: number): string => {
    const parts = formatAmountParts(amountSat, {
      unit: amountUnit,
      hidden: amountHidden,
      locale,
    });
    return `${parts.text} ${parts.unitLabel}`;
  };

  const paymentBubbleFor = (message: MessageRecord): PaymentBubble | null => {
    const info = paymentInfoByRumorId.get(message.rumorId);
    if (info === undefined) return null;
    const parts = formatAmountParts(info.amountSat, {
      unit: amountUnit,
      hidden: amountHidden,
      locale,
    });
    const values = { amount: parts.text, unit: parts.unitLabel };
    return {
      label:
        message.direction === "out"
          ? t("chatPaymentOutgoing", values)
          : t("chatPaymentIncoming", values),
      mintHost: mintHostOf(info.mintUrl),
    };
  };

  // ── chat-pay.pay-request / chat-pay.decline-request ──────────────────

  const onPayRequest = (message: MessageRecord, info: PaymentRequestInfo) => {
    if (store === null || peerNpub === null || requestActBusy !== null) return;
    setRequestActBusy(message.rumorId);
    void sendCashuInChat(store, {
      peerNpub,
      amountSat: info.amountSat,
      contactId: contact?.id,
      paysRequest: {
        requestRumorId: message.rumorId,
        requestId: info.requestId,
        mintUrls: info.mintUrls,
      },
    })
      .then((outcome) => {
        if (outcome.kind === "sent") {
          paidOverlay.show(
            paidOverlayTitle(
              t,
              outcome.amountSat,
              { unit: amountUnit, hidden: amountHidden, locale },
              title,
            ),
          );
          return;
        }
        // Request pays never arm the queue seam, so "queued" cannot occur.
        if (outcome.kind !== "failed") return;
        const failure = payFailureMessage(outcome);
        toast.error(`${t(failure.key)}${failure.detail === null ? "" : `: ${failure.detail}`}`);
      })
      .finally(() => setRequestActBusy(null));
  };

  const onDeclineRequest = (message: MessageRecord) => {
    if (store === null || peerNpub === null || requestActBusy !== null) return;
    setRequestActBusy(message.rumorId);
    void declinePaymentRequestInChat(store, {
      peerNpub,
      requestRumorId: message.rumorId,
    })
      .then((outcome) => {
        if (outcome.kind !== "declined") toast.error(t("errorPrefix"));
      })
      .finally(() => setRequestActBusy(null));
  };

  const requestBubbleFor = (message: MessageRecord): RequestBubble | null => {
    const info = requestInfoByRumorId.get(message.rumorId);
    if (info === undefined) return null;
    const status: RequestCardStatus =
      requestResponses.get(message.rumorId)?.status ?? "requested";
    const statusLabel =
      status === "paid"
        ? t("paymentRequestStatusPaid")
        : status === "declined"
          ? t("paymentRequestStatusDeclined")
          : t("paymentRequestStatusRequested");
    return {
      title: t("requestPaymentLabel"),
      amountLabel: formatSat(info.amountSat),
      status,
      statusLabel,
      description: info.description,
      canAct: message.direction === "in" && status === "requested",
      busy: requestActBusy === message.rumorId,
      payLabel: t("pay"),
      declineLabel: t("decline"),
      onPay: () => onPayRequest(message, info),
      onDecline: () => onDeclineRequest(message),
    };
  };

  const declineTextFor = (message: MessageRecord): string | null =>
    declineMessageInfo(message.content) !== null ? t("paymentRequestDeclinedMessage") : null;

  // ── chat-pay.contact-method (#46) ─────────────────────────────────────

  // `settings.pay-with-cashu` gates the Cashu option; re-read per sheet
  // open so a toggle flip (settings UI in #56, dev hook today) holds.
  const payWithCashuQuery = useEffectQuery(loadPayWithCashuEnabled, [payOpen]);
  const payWithCashuEnabled =
    payWithCashuQuery.status === "success" ? payWithCashuQuery.data : true;
  const payMethods = contactPayMethodOptions({
    peerNpub,
    lnAddress: contact?.lnAddress ?? null,
    payWithCashuEnabled,
  });
  // The method ACTUALLY paid: the explicit pick, else the default — and a
  // failing method never falls back to the other one (feature-map
  // contract: contact pay never silently switches).
  const effectivePayMethod = payMethod ?? payMethods.defaultMethod;

  const openPaySheet = () => {
    setPayMethod(null); // fresh default each open (PoC resets per route visit)
    setPayOpen(true);
  };

  // ── chat-pay.send-cashu ───────────────────────────────────────────────

  const onChatPay = () => {
    if (store === null || peerNpub === null || payBusy) return;
    const amountSat = parseChatPayAmount(payAmount);
    if (amountSat === null || effectivePayMethod === null) return;

    // Lightning (#39 pay-address flow): hand off to the LNURL-pay screen
    // with the contact's address + the amount prefilled (PoC
    // `lnAddressPay` navigation).
    if (effectivePayMethod === "lightning") {
      const lnAddress = contact?.lnAddress?.trim() ?? "";
      if (lnAddress === "") return;
      setPayOpen(false);
      setPayAmount("");
      router.push(
        `/wallet/pay-address?target=${encodeURIComponent(lnAddress)}&amount=${amountSat}`,
      );
      return;
    }

    setPayBusy(true);
    // Saved contacts go through the #46 queue seam (offline → intent
    // queued); unknown threads keep the plain #44 send (PoC parity: the
    // queue keys on contact rows).
    const send =
      contact !== null
        ? sendCashuToContactOrQueue(store, { peerNpub, contactId: contact.id, amountSat })
        : sendCashuInChat(store, { peerNpub, amountSat });
    void send
      .then((outcome) => {
        if (outcome.kind === "sent") {
          setPayOpen(false);
          setPayAmount("");
          paidOverlay.show(
            paidOverlayTitle(
              t,
              outcome.amountSat,
              { unit: amountUnit, hidden: amountHidden, locale },
              title,
            ),
          );
          return;
        }
        if (outcome.kind === "queued") {
          setPayOpen(false);
          setPayAmount("");
          const parts = formatAmountParts(outcome.amountSat, {
            unit: amountUnit,
            hidden: amountHidden,
            locale,
          });
          paidOverlay.show(
            t("paidQueuedTo", { amount: parts.text, unit: parts.unitLabel, name: title }),
          );
          return;
        }
        const message = payFailureMessage(outcome);
        toast.error(`${t(message.key)}${message.detail === null ? "" : `: ${message.detail}`}`);
      })
      .finally(() => setPayBusy(false));
  };

  // ── chat-pay.request ──────────────────────────────────────────────────

  const onChatRequest = () => {
    if (store === null || peerNpub === null || payBusy) return;
    const amountSat = parseChatPayAmount(payAmount);
    if (amountSat === null) return;
    setPayBusy(true);
    void sendPaymentRequestInChat(store, {
      peerNpub,
      amountSat,
      contactId: contact?.id,
    })
      .then((outcome) => {
        if (outcome.kind === "requested") {
          setPayOpen(false);
          setPayAmount("");
          return;
        }
        const failure = payFailureMessage(outcome);
        toast.error(`${t(failure.key)}${failure.detail === null ? "" : `: ${failure.detail}`}`);
      })
      .finally(() => setPayBusy(false));
  };

  // Wire-format contents quote as localized labels (PoC
  // formatChatMessagePreviewText), never as raw token/creq text.
  const quotedContentPreview = (original: MessageRecord): string => {
    const token = tokenMessageInfo(original.content);
    if (token !== null) {
      const parts = formatAmountParts(token.amountSat, {
        unit: amountUnit,
        hidden: amountHidden,
        locale,
      });
      const values = { amount: parts.text, unit: parts.unitLabel };
      return original.direction === "out"
        ? t("chatPaymentOutgoing", values)
        : t("chatPaymentIncoming", values);
    }
    const request = requestMessageInfo(original.content);
    if (request !== null) {
      const values = { amount: formatSat(request.amountSat) };
      return original.direction === "out"
        ? t("paymentRequestPreviewOutgoing", values)
        : t("paymentRequestPreviewIncoming", values);
    }
    if (declineMessageInfo(original.content) !== null) {
      return original.direction === "out"
        ? t("paymentRequestDeclinedPreviewOutgoing")
        : t("paymentRequestDeclinedPreviewIncoming");
    }
    return replyPreviewText(original.content);
  };

  const replyQuoteFor = (message: MessageRecord): string | null => {
    if (message.replyToRumorId === null) return null;
    const original =
      byRumorId.get(message.replyToRumorId) ??
      ready?.replyPreviews.get(message.replyToRumorId) ??
      null;
    return original === null ? t("chatReplyUnavailable") : quotedContentPreview(original);
  };

  // ── Composer actions ──────────────────────────────────────────────────

  const onSend = () => {
    if (store === null || peerNpub === null || sendBusy) return;
    const text = draft.trim();
    if (text === "") return;
    setSendBusy(true);

    const finish = (failed: boolean) => {
      if (failed) {
        toast.error(t("errorPrefix"));
      } else {
        setDraft("");
        setReplyTo(null);
        setEditing(null);
      }
      setSendBusy(false);
    };

    if (editing !== null) {
      void editChatMessage(store, peerNpub, editing, text).then((result) =>
        finish(result.outcome === "failed"),
      );
      return;
    }
    void sendChatMessage(
      store,
      peerNpub,
      text,
      replyTo === null ? undefined : { replyToId: replyTo.rumorId },
    ).then((result) => finish(result.outcome === "failed"));
  };

  const onReact = (message: MessageRecord, emoji: string) => {
    if (store === null || peerNpub === null || ready === null || ready.ownNpub === null) return;
    const mine = myReactionsOnMessage(ready.reactions, message.rumorId, ready.ownNpub);
    void toggleReaction(store, peerNpub, message, mine, emoji).then((result) => {
      if (result.outcome === "failed") toast.error(t("errorPrefix"));
    });
  };

  const onStartReply = (message: MessageRecord) => {
    setEditing(null);
    setReplyTo(message);
  };

  const onStartEdit = (message: MessageRecord) => {
    setReplyTo(null);
    setEditing(message);
    setDraft(message.content);
  };

  const onCopy = (message: MessageRecord) => {
    void copyToClipboard(message.content).then((ok) => {
      if (ok) toast.success(t("copiedToClipboard"));
    });
  };

  const cancelContext = () => {
    if (editing !== null) setDraft("");
    setReplyTo(null);
    setEditing(null);
  };

  // ── Thread-level actions ──────────────────────────────────────────────

  const onRemoveChat = () => {
    if (store === null || peerNpub === null || busy) return;
    Alert.alert(t("removeChat"), t("chatUnknownContactRemoveConfirm"), [
      { text: t("cancel"), style: "cancel" },
      {
        text: t("removeChat"),
        style: "destructive",
        onPress: () => {
          setBusy(true);
          void deleteChat(store, peerNpub)
            .then((result) => {
              if (result.outcome === "failed") {
                toast.error(t("errorPrefix"));
                return;
              }
              toast.success(t("chatUnknownContactRemoved"));
              router.back();
            })
            .finally(() => setBusy(false));
        },
      },
    ]);
  };

  const onPromote = () => {
    if (store === null || unknownThread === null || busy) return;
    setBusy(true);
    void promoteUnknownThread(store, unknownThread.id)
      .then((result) => {
        if (result.outcome === "failed") {
          toast.error(t("chatUnknownContactAddFailed"));
          return;
        }
        toast.success(t("contactSaved"));
        // The thread id is gone; continue the conversation as the contact.
        router.replace(`/chat/${result.contactId}`);
      })
      .finally(() => setBusy(false));
  };

  const onBlock = () => {
    if (store === null || unknownThread === null || busy) return;
    const npub = unknownThread.npub;
    Alert.alert(t("blockContact"), t("chatUnknownContactBlockConfirm"), [
      { text: t("cancel"), style: "cancel" },
      {
        text: t("blockContact"),
        style: "destructive",
        onPress: () => {
          setBusy(true);
          void blockSender(store, npub)
            .then((result) => {
              if (!result.blocked) {
                toast.error(t("errorPrefix"));
                return;
              }
              toast.success(t("chatUnknownContactBlocked"));
              router.replace("/(tabs)");
            })
            .finally(() => setBusy(false));
        },
      },
    ]);
  };

  const canSend = draft.trim().length > 0 && peerNpub !== null && !sendBusy;
  // Native-stack header ≈ 44pt + status bar; KeyboardAvoidingView needs the
  // total obstruction above this screen (no @react-navigation import here).
  const keyboardOffset = insets.top + 44;

  return (
    <>
      <Stack.Screen
        options={{
          title,
          headerRight: () => (
            <View className="flex-row items-center gap-4">
              {contact !== null && (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t("contact")}
                  testID="chat-open-contact"
                  hitSlop={8}
                  onPress={() => router.push(`/contact/${contact.id}`)}
                >
                  <Text weight="semibold" className="text-primary">
                    {t("contact")}
                  </Text>
                </Pressable>
              )}
              {peerNpub !== null && (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t("removeChat")}
                  testID="chat-menu"
                  hitSlop={8}
                  onPress={onRemoveChat}
                >
                  <Text className="text-xl leading-6 opacity-70">🗑</Text>
                </Pressable>
              )}
            </View>
          ),
        }}
      />
      <KeyboardAvoidingView
        className="flex-1 bg-background"
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={keyboardOffset}
      >
        {state.status === "loading" && (
          <Text className="px-6 pt-4 text-sm opacity-60">{t("loadingMore")}</Text>
        )}
        {state.status === "not-found" && (
          <Text className="px-6 pt-4 opacity-70" testID="chat-not-found">
            {t("contactNotFound")}
          </Text>
        )}
        {ready !== null && (
          <>
            {unknownThread !== null && (
              <Surface className="mx-6 mt-4 gap-3" testID="chat-unknown-banner">
                <Text className="text-sm">{t("chatUnknownContactWarning")}</Text>
                <View className="flex-row gap-3">
                  <View className="flex-1">
                    <Button
                      label={t("addContact")}
                      variant="primary"
                      disabled={busy}
                      testID="chat-unknown-add"
                      onPress={onPromote}
                    />
                  </View>
                  <View className="flex-1">
                    <Button
                      label={t("blockContact")}
                      variant="secondary"
                      disabled={busy}
                      testID="chat-unknown-block"
                      onPress={onBlock}
                    />
                  </View>
                </View>
              </Surface>
            )}

            {ready.messages.length === 0 ? (
              <View className="flex-1 px-6 py-4">
                <Text className="text-sm opacity-60">{t("chatEmpty")}</Text>
              </View>
            ) : (
              <FlatList
                inverted
                data={ready.messages}
                keyExtractor={(message) => message.id}
                className="flex-1 px-6"
                contentContainerClassName="gap-2 py-4"
                testID="chat-messages"
                onEndReached={loadOlder}
                onEndReachedThreshold={0.4}
                keyboardShouldPersistTaps="handled"
                renderItem={({ item }) => (
                  <MessageBubble
                    message={item}
                    chips={chipsByMessage.get(item.rumorId) ?? []}
                    replyQuote={replyQuoteFor(item)}
                    payment={paymentBubbleFor(item)}
                    request={requestBubbleFor(item)}
                    declineText={declineTextFor(item)}
                    locale={locale}
                    pendingLabel={t("chatPendingShort")}
                    editedLabel={t("chatEdited")}
                    onLongPress={setActionTarget}
                    onToggleChip={onReact}
                  />
                )}
              />
            )}

            {/* Composer (enabled for unknown senders too — PoC behavior). */}
            {peerNpub !== null && (
              <View className="px-4" style={{ paddingBottom: insets.bottom + 8 }}>
                {(replyTo !== null || editing !== null) && (
                  <View
                    className="mb-2 flex-row items-center gap-2 rounded-xl bg-surface px-3 py-2"
                    testID="chat-composer-context"
                  >
                    <View className="flex-1">
                      <Text weight="semibold" className="text-xs text-primary">
                        {editing !== null ? t("chatEditing") : t("chatReplyingTo")}
                      </Text>
                      <Text numberOfLines={1} className="text-xs opacity-70">
                        {editing !== null
                          ? replyPreviewText(editing.content)
                          : replyTo !== null
                            ? quotedContentPreview(replyTo)
                            : ""}
                      </Text>
                    </View>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={t("cancel")}
                      testID="chat-context-cancel"
                      hitSlop={8}
                      onPress={cancelContext}
                    >
                      <Text className="text-lg opacity-60">✕</Text>
                    </Pressable>
                  </View>
                )}
                <View className="flex-row items-end gap-2">
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t("chatPayAction")}
                    testID="chat-pay-open"
                    onPress={openPaySheet}
                    className="h-11 w-11 items-center justify-center rounded-full bg-surface active:opacity-60"
                  >
                    <Text className="text-xl leading-7">⚡</Text>
                  </Pressable>
                  <TextInput
                    value={draft}
                    onChangeText={setDraft}
                    placeholder={t("chatPlaceholder")}
                    placeholderTextColor={PLACEHOLDER_COLOR}
                    multiline
                    className="max-h-32 flex-1 rounded-2xl bg-surface px-4 py-3 font-sans text-base text-foreground"
                    testID="chat-composer-input"
                  />
                  <Button
                    label={editing !== null ? t("chatSaveAction") : t("send")}
                    variant="primary"
                    disabled={!canSend}
                    testID="chat-send"
                    onPress={onSend}
                    className="px-4"
                  />
                </View>
              </View>
            )}
          </>
        )}
      </KeyboardAvoidingView>

      {/* chat-pay.send-cashu: amount sheet (#44). */}
      <Modal
        visible={payOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setPayOpen(false)}
      >
        <KeyboardAvoidingView
          className="flex-1 justify-end"
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <Pressable
            className="absolute inset-0 bg-black/50"
            onPress={() => {
              if (!payBusy) setPayOpen(false);
            }}
            accessibilityLabel={t("cancel")}
            testID="chat-pay-backdrop"
          />
          <View
            className="gap-3 rounded-t-3xl bg-surface px-6 pt-5"
            style={{ paddingBottom: insets.bottom + 16 }}
            testID="chat-pay-sheet"
          >
            <Text weight="bold" className="text-lg">
              {t("chatPayAction")}
            </Text>
            {/* chat-pay.contact-method (#46): explicit Cashu/Lightning
                chooser when the contact supports both — the selected method
                is the one paid, never a silent switch. */}
            {payMethods.showChooser && (
              <View className="flex-row gap-2" testID="chat-pay-method">
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t("chatPayMethodCashu")}
                  testID="chat-pay-method-cashu"
                  disabled={payBusy}
                  onPress={() => setPayMethod("cashu")}
                  className={`flex-1 flex-row items-center justify-center gap-2 rounded-2xl px-4 py-3 ${
                    effectivePayMethod === "cashu" ? "bg-primary" : "bg-background"
                  }`}
                >
                  <Text className="text-base leading-5">🥜</Text>
                  <Text
                    weight="semibold"
                    className={effectivePayMethod === "cashu" ? "text-primary-foreground" : ""}
                  >
                    {t("chatPayMethodCashu")}
                  </Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t("chatPayMethodLightning")}
                  testID="chat-pay-method-lightning"
                  disabled={payBusy}
                  onPress={() => setPayMethod("lightning")}
                  className={`flex-1 flex-row items-center justify-center gap-2 rounded-2xl px-4 py-3 ${
                    effectivePayMethod === "lightning" ? "bg-primary" : "bg-background"
                  }`}
                >
                  <Text className="text-base leading-5">⚡</Text>
                  <Text
                    weight="semibold"
                    className={
                      effectivePayMethod === "lightning" ? "text-primary-foreground" : ""
                    }
                  >
                    {t("chatPayMethodLightning")}
                  </Text>
                </Pressable>
              </View>
            )}
            {/* settings.pay-with-cashu gate notice (PoC payWithCashuDisabled). */}
            {!payWithCashuEnabled && peerNpub !== null && (
              <Text className="text-sm opacity-70" testID="chat-pay-cashu-disabled">
                {t("payWithCashuDisabled")}
              </Text>
            )}
            <TextInput
              value={payAmount}
              onChangeText={setPayAmount}
              placeholder={t("chatPayAmountPlaceholder")}
              placeholderTextColor={PLACEHOLDER_COLOR}
              keyboardType="number-pad"
              autoFocus
              editable={!payBusy}
              className="rounded-2xl bg-background px-4 py-3 font-sans text-base text-foreground"
              testID="chat-pay-amount"
            />
            <Button
              label={payBusy ? "…" : t("send")}
              variant="primary"
              disabled={
                payBusy || parseChatPayAmount(payAmount) === null || effectivePayMethod === null
              }
              testID="chat-pay-send"
              onPress={onChatPay}
            />
            <Button
              label={payBusy ? "…" : t("requestPaymentSend")}
              variant="secondary"
              disabled={payBusy || parseChatPayAmount(payAmount) === null}
              testID="chat-pay-request"
              onPress={onChatRequest}
            />
            <Button
              label={t("cancel")}
              variant="secondary"
              disabled={payBusy}
              testID="chat-pay-cancel"
              onPress={() => setPayOpen(false)}
            />
          </View>
        </KeyboardAvoidingView>
      </Modal>

      <MessageActionSheet
        message={actionTarget}
        canEdit={actionTarget?.direction === "out"}
        labels={{ reply: t("chatReplyAction"), edit: t("chatEditAction"), copy: t("copy") }}
        onClose={() => setActionTarget(null)}
        onReact={onReact}
        onReply={onStartReply}
        onEdit={onStartEdit}
        onCopy={onCopy}
      />
    </>
  );
}
