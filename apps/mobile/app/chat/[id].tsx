/**
 * Chat thread view (#28): renders one conversation for a saved contact OR
 * an unknown sender — the contacts list routes both here (the id is a
 * contact id or an unknown-thread id, resolved by useChatThread).
 *
 * Deliberately minimal: the full chat experience (composer, replies,
 * reactions, pagination) is #29. The PoC ALLOWS replying to unknown
 * senders (its compose box only needs a peer pubkey), so when #29 lands
 * the composer it must be enabled on unknown threads too — same route,
 * same screen, this banner on top.
 *
 * Unknown threads get the PoC's warning banner (`contacts.unknown`):
 * - Add contact → `contacts.promote-unknown` (messages follow the npub;
 *   the route is replaced with the new contact id).
 * - Block → confirm dialog → `contacts.block` (local block + merged
 *   kind-10000 mute-list publish; thread removed; back to the list).
 *
 * Saved contacts get a header link to the contact detail screen
 * (delete / block-archived live there).
 */
import { Button, Surface, Text } from "@linky/ui";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { Alert, Pressable, ScrollView, View } from "react-native";

import { useChatThread } from "../../src/chat/useChatThread";
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
import { useLinkyStore } from "../../src/store/useLinkyStore";
import { toast } from "../../src/toast";
import type { MessageRecord } from "@linky/evolu-store";

function MessageBubble({
  message,
  locale,
}: {
  readonly message: MessageRecord;
  readonly locale: string;
}) {
  const isOut = message.direction === "out";
  return (
    <View className={`max-w-[80%] ${isOut ? "self-end" : "self-start"}`}>
      <View className={`rounded-2xl px-4 py-2.5 ${isOut ? "bg-primary" : "bg-surface"}`}>
        <Text className={isOut ? "text-primary-foreground" : "text-foreground"}>
          {message.content}
        </Text>
      </View>
      <Text className={`px-1 pt-0.5 text-xs opacity-50 ${isOut ? "text-right" : "text-left"}`}>
        {formatPreviewTimestamp(message.sentAtSec, Date.now(), locale)}
      </Text>
    </View>
  );
}

export default function ChatScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { t, locale } = useLocale();
  const router = useRouter();
  const storeState = useLinkyStore();
  const store = storeState.status === "ready" ? storeState.store : null;
  const state = useChatThread(store, id ?? null);
  const [busy, setBusy] = useState(false);

  const unknownThread =
    state.status === "ready" && state.thread.kind === "unknown" ? state.thread.thread : null;
  const contact =
    state.status === "ready" && state.thread.kind === "contact" ? state.thread.contact : null;

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

  return (
    <>
      <Stack.Screen
        options={{
          title,
          ...(contact !== null
            ? {
                headerRight: () => (
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
                ),
              }
            : {}),
        }}
      />
      <View className="flex-1 bg-background">
        {state.status === "loading" && (
          <Text className="px-6 pt-4 text-sm opacity-60">{t("loadingMore")}</Text>
        )}
        {state.status === "not-found" && (
          <Text className="px-6 pt-4 opacity-70" testID="chat-not-found">
            {t("contactNotFound")}
          </Text>
        )}
        {state.status === "ready" && (
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
            <ScrollView
              className="flex-1 px-6"
              contentContainerClassName="gap-2 py-4"
              testID="chat-messages"
            >
              {state.messages.length === 0 ? (
                <Text className="text-sm opacity-60">{t("chatEmpty")}</Text>
              ) : (
                state.messages.map((message) => (
                  <MessageBubble key={message.id} message={message} locale={locale} />
                ))
              )}
            </ScrollView>
          </>
        )}
      </View>
    </>
  );
}
