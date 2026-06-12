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
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useMemo, useState } from "react";
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
import { sendCashuInChat } from "../../src/chat/chatPayActions";
import { setActiveChatThread } from "../../src/notifications/activeThread";
import {
  mintHostOf,
  parseChatPayAmount,
  tokenMessageInfo,
} from "../../src/chat/chatPaymentsModel";
import type { TokenMessageInfo } from "../../src/chat/chatPaymentsModel";
import {
  myReactionsOnMessage,
  reactionChipsByMessage,
  replyPreviewText,
} from "../../src/chat/conversationModel";
import { paidOverlay } from "../../src/paidOverlay";
import { useAmountDisplay } from "../../src/wallet/AmountDisplayProvider";
import { payFailureMessage } from "../../src/wallet/payModel";
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

interface BubbleProps {
  readonly message: MessageRecord;
  readonly chips: ReadonlyArray<ReactionChip>;
  readonly replyQuote: string | null;
  readonly payment: PaymentBubble | null;
  readonly locale: string;
  readonly pendingLabel: string;
  readonly editedLabel: string;
  readonly onLongPress: (message: MessageRecord) => void;
  readonly onToggleChip: (message: MessageRecord, emoji: string) => void;
}

function MessageBubble({
  message,
  chips,
  replyQuote,
  payment,
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

  // Claim detection (#44): notice issued chat tokens the peer accepted.
  useEffect(() => {
    if (store !== null) maybeCheckIssuedTokens(store);
  }, [store]);

  // notifications (#52): the open conversation never alerts — the in-app
  // rich notifier skips the active thread (duplicate-alert suppression).
  useEffect(() => {
    setActiveChatThread(id ?? null);
    return () => setActiveChatThread(null);
  }, [id]);

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

  // ── chat-pay.send-cashu ───────────────────────────────────────────────

  const onChatPay = () => {
    if (store === null || peerNpub === null || payBusy) return;
    const amountSat = parseChatPayAmount(payAmount);
    if (amountSat === null) return;
    setPayBusy(true);
    void sendCashuInChat(store, {
      peerNpub,
      amountSat,
      contactId: contact?.id,
    })
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
        const message = payFailureMessage(outcome);
        toast.error(`${t(message.key)}${message.detail === null ? "" : `: ${message.detail}`}`);
      })
      .finally(() => setPayBusy(false));
  };

  const replyQuoteFor = (message: MessageRecord): string | null => {
    if (message.replyToRumorId === null) return null;
    const original =
      byRumorId.get(message.replyToRumorId) ??
      ready?.replyPreviews.get(message.replyToRumorId) ??
      null;
    return original === null ? t("chatReplyUnavailable") : replyPreviewText(original.content);
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
                        {replyPreviewText((editing ?? replyTo)?.content ?? "")}
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
                    onPress={() => setPayOpen(true)}
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
              disabled={payBusy || parseChatPayAmount(payAmount) === null}
              testID="chat-pay-send"
              onPress={onChatPay}
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
