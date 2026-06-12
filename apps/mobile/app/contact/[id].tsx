/**
 * Contact detail (#28, partial): shows the saved contact and carries the
 * two lifecycle actions this issue owns —
 *
 * - Delete contact → `contacts.delete-to-unknown`: confirm dialog, then
 *   the contact row is soft-deleted (tombstone syncs, so no device
 *   recreates it) and an existing conversation is preserved under a
 *   local-only unknown thread.
 * - Block (archived contacts only, PoC parity) → `contacts.block`: confirm
 *   dialog, local block + merged kind-10000 mute-list publish, contact row
 *   removed. History stays; future inbound from the sender is dropped.
 *
 * The full add/edit form (fields, groups, refresh-from-Nostr) is #27 —
 * when it lands, these actions plug into its screen via
 * `src/contacts/contactThreadActions.ts` unchanged. `/contact/new` (the
 * add stub) keeps rendering the placeholder text.
 */
import { Button, Surface, Text } from "@linky/ui";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Alert, View } from "react-native";

import {
  blockArchivedContact,
  deleteContactToUnknown,
} from "../../src/contacts/contactThreadActions";
import { contactDisplayName, shortNpub } from "../../src/contacts/contactsListModel";
import { useLocale } from "../../src/locales";
import { getStoreDataVersion, subscribeToStoreData } from "../../src/store/storeManager";
import { useLinkyStore } from "../../src/store/useLinkyStore";
import { toast } from "../../src/toast";
import { createContactsRepository } from "@linky/evolu-store";
import type { ContactRecord, LinkyStore } from "@linky/evolu-store";

type ContactState =
  | { readonly status: "loading" }
  | { readonly status: "not-found" }
  | { readonly status: "ready"; readonly contact: ContactRecord };

const useContact = (store: LinkyStore | null, id: string | null): ContactState => {
  const [state, setState] = useState<ContactState>({ status: "loading" });
  const dataVersion = useSyncExternalStore(subscribeToStoreData, getStoreDataVersion);

  useEffect(() => {
    if (store === null || id === null || id.length === 0 || id === "new") {
      setState(id === "new" ? { status: "not-found" } : { status: "loading" });
      return;
    }
    let stale = false;
    void createContactsRepository(store)
      .getById(id)
      .then((contact) => {
        if (stale) return;
        setState(contact === null ? { status: "not-found" } : { status: "ready", contact });
      });
    return () => {
      stale = true;
    };
  }, [store, id, dataVersion]);

  return state;
};

function FieldRow({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <View className="gap-0.5">
      <Text className="text-xs uppercase tracking-widest opacity-50">{label}</Text>
      <Text>{value}</Text>
    </View>
  );
}

export default function ContactDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { t, locale } = useLocale();
  const router = useRouter();
  const storeState = useLinkyStore();
  const store = storeState.status === "ready" ? storeState.store : null;
  const state = useContact(store, id ?? null);
  const [busy, setBusy] = useState(false);

  const contact = state.status === "ready" ? state.contact : null;
  const isArchived = contact?.archivedAtSec !== null && contact !== null;

  const onDelete = () => {
    if (store === null || contact === null || busy) return;
    Alert.alert(t("deleteContact"), t("deleteContactConfirm"), [
      { text: t("cancel"), style: "cancel" },
      {
        text: t("delete"),
        style: "destructive",
        onPress: () => {
          setBusy(true);
          void deleteContactToUnknown(store, contact.id)
            .then((result) => {
              if (result === "failed") {
                toast.error(t("errorPrefix"));
                return;
              }
              toast.success(t("contactDeleted"));
              router.replace("/(tabs)");
            })
            .finally(() => setBusy(false));
        },
      },
    ]);
  };

  const onBlock = () => {
    if (store === null || contact === null || busy) return;
    Alert.alert(t("blockContact"), t("chatUnknownContactBlockConfirm"), [
      { text: t("cancel"), style: "cancel" },
      {
        text: t("blockContact"),
        style: "destructive",
        onPress: () => {
          setBusy(true);
          void blockArchivedContact(store, contact.id)
            .then((result) => {
              if (!result.blocked) {
                toast.error(t("errorPrefix"));
                return;
              }
              toast.success(t("contactBlocked"));
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
        options={{ title: contact !== null ? contactDisplayName(contact, locale) : t("contact") }}
      />
      <View className="flex-1 gap-4 bg-background px-6 pt-4">
        {state.status === "loading" && (
          <Text className="text-sm opacity-60">{t("loadingMore")}</Text>
        )}
        {state.status === "not-found" && (
          // /contact/new lands here too until #27 brings the real form.
          <Surface>
            <Text testID="contact-not-found">{t("contactNotFound")}</Text>
          </Surface>
        )}
        {contact !== null && (
          <>
            <Surface className="gap-3" testID="contact-detail">
              <FieldRow label={t("name")} value={contactDisplayName(contact, locale)} />
              {contact.npub !== null && <FieldRow label={t("npub")} value={shortNpub(contact.npub)} />}
              {contact.lnAddress !== null && (
                <FieldRow label={t("lightningAddress")} value={contact.lnAddress} />
              )}
              {contact.groupName !== null && <FieldRow label={t("group")} value={contact.groupName} />}
              {isArchived && (
                <Text className="text-sm text-danger" testID="contact-archived-flag">
                  {t("archiveFilter")}
                </Text>
              )}
            </Surface>

            <View className="gap-3">
              {/* contacts.block from an archived contact (PoC: archived edit screen). */}
              {isArchived && (
                <Button
                  label={t("blockContact")}
                  variant="danger"
                  disabled={busy}
                  testID="contact-block"
                  onPress={onBlock}
                />
              )}
              <Button
                label={t("deleteContact")}
                variant="danger"
                disabled={busy}
                testID="contact-delete"
                onPress={onDelete}
              />
            </View>
          </>
        )}
      </View>
    </>
  );
}
